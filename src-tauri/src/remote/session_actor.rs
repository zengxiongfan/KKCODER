use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::{broadcast, mpsc};

use super::state::{AtomicSessionStatus, InputCommand, OutputFrame, ReplayBuffer, SessionStatus};

/// 同步 Writer 包装为 tokio AsyncWrite
pub struct SyncWriter {
    inner: Option<Box<dyn std::io::Write + Send>>,
}

impl SyncWriter {
    pub fn new(writer: Box<dyn std::io::Write + Send>) -> Self {
        Self {
            inner: Some(writer),
        }
    }

    pub fn take_writer(&mut self) -> Option<Box<dyn std::io::Write + Send>> {
        self.inner.take()
    }
}

impl tokio::io::AsyncWrite for SyncWriter {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.inner.as_mut() {
            Some(w) => match w.write_all(buf) {
                Ok(()) => Poll::Ready(Ok(buf.len())),
                Err(e) => Poll::Ready(Err(e)),
            },
            None => Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "Writer taken",
            ))),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.inner.as_mut() {
            Some(w) => match w.flush() {
                Ok(()) => Poll::Ready(Ok(())),
                Err(e) => Poll::Ready(Err(e)),
            },
            None => Poll::Ready(Ok(())),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

/// 同步 Reader 包装为 tokio AsyncRead
pub struct SyncReader {
    inner: Option<Box<dyn std::io::Read + Send>>,
}

impl SyncReader {
    pub fn new(reader: Box<dyn std::io::Read + Send>) -> Self {
        Self {
            inner: Some(reader),
        }
    }
}

impl tokio::io::AsyncRead for SyncReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.inner.as_mut() {
            Some(r) => {
                let unfilled = buf.initialize_unfilled();
                match r.read(unfilled) {
                    Ok(0) => Poll::Ready(Ok(())),
                    Ok(n) => {
                        buf.advance(n);
                        Poll::Ready(Ok(()))
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        // 对于阻塞读，返回 Pending 并安排唤醒
                        // 这不完美但在 tokio::select! 中可以工作
                        Poll::Pending
                    }
                    Err(e) => Poll::Ready(Err(e)),
                }
            }
            None => Poll::Ready(Ok(())),
        }
    }
}

/// 会话 Actor - 每个活跃 PTY 会话独立运行
pub struct SessionActor {
    session_id: String,
    input_rx: mpsc::Receiver<InputCommand>,
    output_tx: broadcast::Sender<OutputFrame>,
    replay: Arc<ReplayBuffer>,
    status: Arc<AtomicSessionStatus>,
    pty_writer: Box<dyn tokio::io::AsyncWrite + Unpin + Send>,
    pty_reader: Box<dyn tokio::io::AsyncRead + Unpin + Send>,
    seq: u64,
}

impl SessionActor {
    pub fn new(
        session_id: String,
        input_rx: mpsc::Receiver<InputCommand>,
        output_tx: broadcast::Sender<OutputFrame>,
        replay: Arc<ReplayBuffer>,
        status: Arc<AtomicSessionStatus>,
        pty_writer: Box<dyn tokio::io::AsyncWrite + Unpin + Send>,
        pty_reader: Box<dyn tokio::io::AsyncRead + Unpin + Send>,
    ) -> Self {
        Self {
            session_id,
            input_rx,
            output_tx,
            replay,
            status,
            pty_writer,
            pty_reader,
            seq: 0,
        }
    }

    /// 运行 Actor 主循环
    pub async fn run(mut self) {
        let mut buffer = String::with_capacity(8192);
        let mut last_flush = Instant::now();
        let flush_interval = Duration::from_millis(16); // 16ms 微批
        let max_buffer_size = 4096; // 4KB 立即 flush
        let mut pty_buf = [0u8; 4096];

        self.status.set(SessionStatus::Idle);

        loop {
            tokio::select! {
                // 处理输入
                Some(cmd) = self.input_rx.recv() => {
                    match cmd {
                        InputCommand::Text(text) => {
                            use tokio::io::AsyncWriteExt;
                            if self.pty_writer.write_all(text.as_bytes()).await.is_err() {
                                break;
                            }
                            let _ = self.pty_writer.flush().await;
                        }
                        InputCommand::Resize { cols, rows } => {
                            // Resize 需要通过外部调用，这里只记录
                            let _ = (cols, rows);
                        }
                    }
                }
                // 读取 PTY 输出
                result = {
                    use tokio::io::AsyncReadExt;
                    self.pty_reader.read(&mut pty_buf)
                } => {
                    match result {
                        Ok(n) if n > 0 => {
                            let data = String::from_utf8_lossy(&pty_buf[..n]).to_string();
                            buffer.push_str(&data);

                            // 检查 flush 条件
                            let elapsed = last_flush.elapsed();
                            if elapsed >= flush_interval || buffer.len() >= max_buffer_size {
                                self.flush_buffer(&mut buffer);
                                last_flush = Instant::now();
                            }
                        }
                        _ => break, // EOF 或错误
                    }
                }
                // 定时 flush（即使 buffer 未满）
                _ = tokio::time::sleep(flush_interval) => {
                    if !buffer.is_empty() {
                        self.flush_buffer(&mut buffer);
                        last_flush = Instant::now();
                    }
                }
            }
        }

        // Actor 退出时标记断开状态
        self.status.set(SessionStatus::Disconnected);
        // 最后 flush 剩余数据
        if !buffer.is_empty() {
            self.flush_buffer(&mut buffer);
        }
    }

    /// 将缓冲区内容作为一帧发送
    fn flush_buffer(&mut self, buffer: &mut String) {
        if buffer.is_empty() {
            return;
        }

        self.seq += 1;
        let frame = OutputFrame {
            seq: self.seq,
            session_id: self.session_id.clone(),
            data: buffer.clone(),
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        };

        // 存入 ring buffer
        self.replay.push(frame.clone());

        // 广播给订阅者（忽略没有接收者的错误）
        let _ = self.output_tx.send(frame);

        buffer.clear();
    }
}
