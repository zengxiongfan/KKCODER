declare module "refractor/lang/*" {
  import type { RefractorNode } from "react-refractor";
  const lang: (refractor: { register: (lang: unknown) => void }) => void;
  export default lang;
}

declare module "refractor/core" {
  interface Refractor {
    register: (lang: unknown) => void;
    highlight: (code: string, language: string) => RefractorNode[];
    alias: (name: string | Record<string, string>, alias: string) => void;
    registered: (language: string) => boolean;
    listLanguages: () => string[];
    highlight: (code: string, language: string) => RefractorNode[];
  }
  const refractor: Refractor;
  export default refractor;
  export type { RefractorNode };
}
