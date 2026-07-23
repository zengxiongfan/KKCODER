import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ConfirmModal } from "./ConfirmModal";
import {
  formatRelativeSessionActivityTime,
  sortSessionsByActivityDesc,
  getSessionActivityTimestamp,
} from "../utils/sessionActivity";

export const ClaudeIcon: React.FC<{ size?: number; color?: string }> = ({ size = 18, color }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ color, display: "inline-block", verticalAlign: "middle" }}>
    <title>Claude</title>
    <path 
      d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" 
      fill="currentColor" 
      fillRule="nonzero"
    />
  </svg>
);

export const CodexIcon: React.FC<{ size?: number; color?: string }> = ({ size = 18, color }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" xmlns="http://www.w3.org/2000/svg" style={{ color, display: "inline-block", verticalAlign: "middle", flex: "0 0 auto", lineHeight: 1 }}>
    <title>Codex</title>
    <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
  </svg>
);

export const CcSwitchIcon: React.FC<{ size?: number; color?: string }> = ({ size = 18, color }) => (
  <svg width={size} height={size} viewBox="0 0 1045 1008" fill="none" style={{ color, display: "inline-block", verticalAlign: "middle" }}>
    <title>CC Switch</title>
    <path d="M 345.075 43.729 C 341.282 44.442, 321.592 51.658, 316.888 54.057 C 310.336 57.400, 302.349 66.041, 298.709 73.726 C 295.697 80.084, 295.501 81.175, 295.517 91.500 L 295.534 102.500 319.869 166 C 341.766 223.138, 350.381 245.666, 371.643 301.375 C 375.185 310.656, 377.858 318.475, 377.583 318.750 C 376.960 319.374, 380.148 321.725, 275.011 243.099 C 226.893 207.114, 185.151 176.585, 182.251 175.258 C 170.665 169.953, 153.294 171.577, 142.258 178.995 C 135.192 183.745, 117.129 205.160, 112.733 214 C 109.653 220.192, 109.500 221.045, 109.500 232 C 109.500 243.394, 109.535 243.565, 113.285 250.582 C 115.367 254.476, 118.742 259.248, 120.785 261.185 C 122.828 263.121, 162.525 293.266, 209 328.173 C 255.475 363.079, 301.825 397.934, 312 405.627 C 322.175 413.320, 331.377 419.946, 332.449 420.352 C 333.522 420.758, 341.172 421.508, 349.449 422.019 C 357.727 422.529, 370.800 423.395, 378.500 423.944 C 404.185 425.772, 433.342 427.913, 448.500 429.084 C 456.750 429.721, 464.850 430.076, 466.500 429.872 L 469.500 429.500 476.609 401 C 480.519 385.325, 485.858 363.710, 488.473 352.967 L 493.228 333.434 489.183 322.967 C 484.941 311.993, 479.011 296.410, 453.997 230.500 C 439.552 192.439, 418.186 136.238, 400.772 90.500 C 389.456 60.780, 387.751 57.796, 378.143 50.916 C 369.130 44.462, 356.160 41.643, 345.075 43.729 M 397.547 624.995 C 376.896 638.743, 360 650.397, 360 650.893 C 360 651.827, 343.905 674.147, 279.880 762 C 259.237 790.325, 240.053 816.650, 237.247 820.500 C 229.509 831.121, 227.601 836.583, 227.645 848 C 227.710 864.838, 232.437 872.956, 249.755 885.965 C 262.196 895.311, 268.537 898.076, 279.085 898.752 C 291.041 899.518, 301.993 895.565, 310.319 887.478 C 312.299 885.555, 321.658 873.299, 331.116 860.241 C 340.574 847.183, 353.570 829.300, 359.996 820.500 C 366.421 811.700, 376.551 797.750, 382.507 789.500 C 397.539 768.676, 409.845 751.837, 411.596 749.696 C 413.135 747.816, 413.848 744.768, 417.021 726.500 C 418.072 720.450, 419.856 710.325, 420.986 704 C 422.116 697.675, 424.165 685.975, 425.539 678 C 426.913 670.025, 428.479 661.138, 429.019 658.250 C 430.112 652.400, 430.903 647.991, 433.996 630.500 C 435.163 623.900, 436.767 615.003, 437.559 610.730 C 439.417 600.711, 439.383 600, 437.047 600 C 435.972 600, 418.197 611.248, 397.547 624.995" stroke="none" fill="#60a6a2" fill-rule="evenodd"></path>
    <path d="M 588.746 43.022 C 578.071 45.718, 566.370 54.961, 561.535 64.519 C 558.940 69.648, 525.455 201.527, 492.985 334.500 C 487.882 355.400, 480.510 385.325, 476.603 401 L 469.500 429.500 466.500 429.872 C 464.850 430.076, 456.750 429.721, 448.500 429.084 C 409.057 426.037, 346.946 421.638, 320.500 420.020 C 311.700 419.482, 302.700 418.800, 300.500 418.506 C 298.300 418.211, 286.150 417.305, 273.500 416.492 C 260.850 415.678, 244.200 414.550, 236.500 413.983 C 228.800 413.417, 216.082 412.519, 208.239 411.987 C 189.119 410.692, 154.503 408.233, 138.500 407.034 C 83.231 402.892, 81.588 402.923, 70.714 408.297 C 52.679 417.210, 45.356 434.747, 46.199 467 C 46.464 477.119, 46.833 479.212, 49.277 484.430 C 54.573 495.739, 63.133 503.557, 74.516 507.479 C 79.504 509.198, 95.040 510.841, 126 512.923 C 135.075 513.533, 148.350 514.480, 155.500 515.027 C 162.650 515.574, 184.475 517.165, 204 518.562 C 223.525 519.960, 245.350 521.533, 252.500 522.057 C 273.007 523.562, 290.762 524.823, 314.500 526.458 C 348.247 528.783, 353.018 529.220, 353.518 530.030 C 353.773 530.442, 343.974 537.498, 331.741 545.710 C 304.438 564.038, 163.002 659.271, 146.584 670.382 C 132.538 679.888, 127.223 686.164, 123.869 697.207 C 121.458 705.142, 121.612 716.357, 124.231 723.695 C 126.868 731.084, 136.351 747.205, 141.161 752.477 C 152.067 764.430, 169.282 768.937, 185.226 764.012 C 192.217 761.853, 191.739 762.164, 351.290 655.838 C 397.375 625.127, 435.962 600, 437.040 600 C 439.383 600, 439.418 600.707, 437.559 610.730 C 436.767 615.003, 435.163 623.900, 433.996 630.500 C 430.903 647.991, 430.112 652.400, 429.019 658.250 C 428.479 661.138, 426.913 670.025, 425.539 678 C 424.165 685.975, 422.116 697.675, 420.986 704 C 419.856 710.325, 418.071 720.450, 417.019 726.500 C 414.891 738.729, 411.301 758.545, 407.506 779 C 406.129 786.425, 403.895 799.025, 402.543 807 C 401.191 814.975, 397.856 833.875, 395.132 849 C 392.408 864.125, 389.629 879.695, 388.957 883.600 C 388.284 887.505, 387.935 894.549, 388.182 899.254 C 388.770 910.457, 392.441 918.255, 400.946 926.367 C 408.355 933.434, 414.597 936.358, 427.848 938.970 C 440.729 941.509, 447.123 941.529, 455.073 939.054 C 466.337 935.549, 475.068 928.001, 480.600 916.988 C 483.387 911.440, 483.510 910.830, 497.009 835.500 C 502.035 807.450, 507.022 780.225, 508.090 775 C 509.159 769.775, 510.265 763.925, 510.549 762 C 511.518 755.425, 514.875 736.517, 519.516 711.500 C 522.067 697.750, 525.433 679.075, 526.998 670 C 535.984 617.866, 539.840 598, 540.973 598 C 541.986 598, 548.512 605.629, 561.075 621.500 C 575.687 639.959, 577 641.715, 577 642.787 C 577 643.336, 577.643 644.033, 578.429 644.334 C 579.214 644.636, 615.895 690.021, 659.941 745.191 C 703.988 800.361, 742.518 848.299, 745.564 851.720 C 758.399 866.138, 778.039 869.968, 795.159 861.392 C 800.487 858.723, 815.709 846.725, 819.253 842.401 C 825.868 834.330, 829.022 825.284, 828.958 814.568 C 828.882 802.012, 825.830 794.486, 815.546 781.500 C 807.752 771.658, 791.980 751.768, 775.899 731.500 C 766.299 719.400, 755.091 705.225, 750.993 700 C 746.894 694.775, 735.862 680.825, 726.477 669 C 717.092 657.175, 702.008 638.107, 692.957 626.627 C 683.905 615.147, 671.623 599.622, 665.663 592.127 C 644.113 565.029, 642.043 561.976, 645.250 562.015 C 647.789 562.046, 667.126 565.721, 721.500 576.505 C 730.850 578.359, 743.675 580.840, 750 582.018 C 756.325 583.196, 768.025 585.450, 776 587.026 C 783.975 588.603, 804.225 592.586, 821 595.878 C 837.775 599.170, 869.050 605.315, 890.500 609.534 C 936.125 618.506, 940.491 618.765, 952.141 613.184 C 969.380 604.925, 975.928 593.145, 981.049 561.177 C 984.341 540.624, 969.905 518.762, 949.628 513.594 C 946.257 512.735, 928.200 509.081, 909.500 505.474 C 890.800 501.867, 864.250 496.662, 850.500 493.906 C 836.750 491.150, 819.425 487.784, 812 486.426 C 804.575 485.068, 797.184 483.512, 795.576 482.970 C 793.968 482.427, 789.693 481.525, 786.076 480.966 C 778.943 479.862, 751.942 474.731, 712.500 466.984 C 698.750 464.283, 680.525 460.721, 672 459.068 C 663.475 457.415, 638.950 452.613, 617.500 448.397 C 596.050 444.181, 577.227 440.510, 575.671 440.240 C 572.047 439.612, 571.422 437.847, 572.798 432.122 C 576.587 416.355, 606.724 294.782, 610.013 282 C 612.206 273.475, 616.227 257.500, 618.948 246.500 C 621.669 235.500, 631.344 196.837, 640.448 160.583 C 652.913 110.941, 657 93.148, 657 88.515 C 657 74.625, 649.817 61.056, 638.482 53.532 C 627.309 46.116, 599.645 40.270, 588.746 43.022" stroke="none" fill="#e78b52" fill-rule="evenodd"></path>
    <path d="M 784.734 136.022 C 780.393 137.121, 773.819 140.334, 769.736 143.353 C 768.183 144.502, 744.319 168.629, 716.706 196.970 C 648.388 267.087, 624.395 291.647, 612.271 303.874 L 601.985 314.248 587.951 370.874 C 580.232 402.018, 573.415 429.580, 572.802 432.122 C 571.422 437.846, 572.046 439.612, 575.671 440.240 C 577.227 440.510, 596.050 444.181, 617.500 448.397 C 638.950 452.613, 663.475 457.415, 672 459.068 C 680.525 460.721, 698.750 464.283, 712.500 466.984 C 748.223 474.001, 778.827 479.853, 783.657 480.591 C 786.723 481.059, 789.874 480.558, 795.657 478.681 C 799.971 477.282, 812.050 473.802, 822.500 470.949 C 832.950 468.095, 843.750 465.105, 846.500 464.303 C 852.424 462.576, 864.873 459.253, 870.500 457.898 C 882.919 454.906, 929.440 441.441, 934.725 439.308 C 950.039 433.128, 960 418.081, 960 401.127 C 960 394.810, 959.172 390.569, 955.643 378.810 C 950.268 360.898, 947.892 356.048, 941.872 350.696 C 930.316 340.422, 924.857 338.001, 913.239 337.999 C 904.582 337.998, 909.466 336.745, 819.500 362.047 C 784.906 371.776, 759.790 378.828, 739.636 384.468 C 726.511 388.142, 713.686 391.765, 711.136 392.519 C 708.586 393.273, 702.769 394.842, 698.210 396.005 C 693.650 397.168, 687.125 399.166, 683.710 400.444 C 676.085 403.297, 667 404.704, 667 403.032 C 667 402.397, 677.237 391.214, 689.750 378.182 C 702.263 365.150, 723.291 343.015, 736.481 328.994 C 749.670 314.972, 767.245 296.525, 775.535 288 C 783.826 279.475, 795.301 267.550, 801.035 261.500 C 806.770 255.450, 817.146 244.650, 824.094 237.500 C 844.492 216.510, 846.768 213.567, 850.032 203.960 C 851.843 198.632, 852.131 196.098, 851.678 189.500 C 850.764 176.198, 848.247 171.220, 836.127 158.748 C 823.618 145.875, 817.335 140.879, 810.054 138.016 C 803.846 135.575, 790.614 134.533, 784.734 136.022 M 644 563.161 C 644 564.450, 649.491 571.792, 665.663 592.127 C 671.623 599.622, 683.905 615.147, 692.957 626.627 C 702.008 638.107, 717.092 657.175, 726.477 669 C 735.862 680.825, 746.894 694.775, 750.993 700 C 755.091 705.225, 766.299 719.400, 775.899 731.500 C 791.980 751.768, 807.752 771.658, 815.546 781.500 C 817.288 783.700, 820.368 788.089, 822.390 791.254 C 825.496 796.115, 827.188 797.588, 833.283 800.741 C 840.393 804.418, 840.671 804.473, 852 804.466 C 861.566 804.460, 864.109 804.126, 867.119 802.480 C 869.110 801.391, 872.534 799.511, 874.728 798.302 C 878.914 795.995, 888.863 785.802, 895.706 776.808 C 905.597 763.808, 907.996 749.653, 902.587 736.215 C 897.807 724.343, 900.699 726.864, 834.500 676.854 C 819.100 665.220, 790.975 644.066, 772 629.846 C 753.025 615.625, 734 601.180, 729.722 597.745 C 725.444 594.310, 719.317 589.700, 716.107 587.500 C 709.169 582.745, 701.183 576.403, 698.758 573.723 C 697.017 571.799, 685.036 568.993, 657.297 564.012 C 644.188 561.658, 644 561.646, 644 563.161 M 539.053 603.250 C 537.680 609.859, 530.749 648.238, 526.998 670 C 525.433 679.075, 522.065 697.750, 519.513 711.500 C 511.840 752.833, 510.184 763.308, 511.063 764.954 C 511.517 765.804, 512.763 769.425, 513.831 773 C 515.687 779.207, 516.341 781.834, 519.436 795.500 C 520.184 798.800, 522.218 806.900, 523.957 813.500 C 527.414 826.619, 536.216 860.671, 544.606 893.379 C 551.891 921.780, 556.029 928.381, 571.309 935.974 C 578.791 939.692, 580.040 940, 587.634 940 C 596.648 940, 610.689 936.779, 618.829 932.844 C 625.847 929.451, 632.437 922.254, 636.718 913.306 C 640.211 906.004, 640.454 904.887, 640.476 896 C 640.498 887.294, 639.856 884.076, 632.801 857.500 C 622.676 819.365, 621.481 814.839, 617.490 799.500 C 615.630 792.350, 612.480 780.425, 610.490 773 C 608.501 765.575, 604.419 749.934, 601.419 738.243 C 598.419 726.551, 594.659 712.956, 593.063 708.031 C 591.467 703.106, 589.634 696.472, 588.991 693.288 C 587.007 683.475, 583.757 670.651, 582.454 667.500 C 580.359 662.434, 578.213 653.799, 577.488 647.516 C 576.735 640.993, 577.639 642.426, 561.075 621.500 C 548.512 605.629, 541.986 598, 540.973 598 C 540.517 598, 539.653 600.362, 539.053 603.250" stroke="none" fill="#f9b53c" fill-rule="evenodd"></path>
  </svg>
);

export type AgentType = "claude" | "codex";

export interface Session {
  id: string;
  name: string;
  project: string;
  path: string;
  type: AgentType;
  agentSessionId: string;
  createdAt?: string; // 保存数据库创建时间戳
  lastUserMessageAt?: string;
  favorite: number;   // 0 代表普通，1 代表已收藏
  deleted?: number;   // 0 代表活动，1 代表回收站
  deletedAt?: string; // 保存软删除时间戳
  isTemp?: boolean;
  matchSnippets?: string[]; // 搜索高亮的聊天记录匹配片段 (最多 3 条)
}

export interface ArchivedProject {
  id: number;
  project_name: string;
  project_path: string;
  archived_at: string;
  archive_month: string;
  sessions_data: string; // JSON string of sessions
}

interface SidebarProps {
  selectedAgent: "claude" | "codex";
  onSelectAgent: (agent: "claude" | "codex") => void;
  onOpenNewSession: (prefilledPath?: string) => void;
  onCreateSessionDirectly?: (projectPath: string) => void;
  onOpenTempSession: () => void;
  sessions: Session[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onDeleteSession: (e: React.MouseEvent | null, id: string) => void;
  openTabIds: string[]; // 用于判断该终端是否“加载到了右边”并点亮绿灯
  onRenameSession?: (id: string, newName: string) => void;
  onToggleFavorite?: (id: string, isFavorite: boolean) => void;
  highlightSessionId?: string | null;
  onHighlightEnd?: () => void;
  onDeleteSessionsBatch: (ids: string[]) => void; // 批量删除会话 callback
  glowingSessionIds?: string[];
  onRestoreSession: (id: string) => void;
  onPermanentlyDeleteSession: (id: string) => void;
  onEmptyTrash: () => void;
  width?: number;
  sessionBusy?: Record<string, boolean>;
}

export const Sidebar: React.FC<SidebarProps> = ({
  selectedAgent,
  onSelectAgent,
  onOpenNewSession,
  onCreateSessionDirectly,
  onOpenTempSession,
  sessions,
  activeSessionId,
  onSelectSession,
  searchQuery,
  onSearchQueryChange,
  onDeleteSession,
  openTabIds,
  onRenameSession,
  onToggleFavorite,
  highlightSessionId,
  onHighlightEnd,
  onDeleteSessionsBatch,
  glowingSessionIds = [],
  onRestoreSession,
  onPermanentlyDeleteSession,
  onEmptyTrash,
  width,
  sessionBusy,
}) => {
  // 1. 折叠项目列表的状态
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);
  // 展开更多会话的状态（默认只显示前5条）
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);
  // 收藏区展开更多会话
  const [favoritesExpanded, setFavoritesExpanded] = useState<boolean>(false);
  // 回收站与确认删除 Modal 状态
  const [showTrashModal, setShowTrashModal] = useState<boolean>(false);
  const [sessionToDelete, setSessionToDelete] = useState<Session | null>(null);
  // 收藏夹折叠状态
  const [favoritesCollapsed, setFavoritesCollapsed] = useState<boolean>(false);
  const [confirmState, setConfirmState] = useState<{
    show: boolean;
    title: string;
    message: string | React.ReactNode;
    onConfirm: () => void;
    isDanger?: boolean;
  } | null>(null);

  // 记住收藏的项目状态
  const [favoriteProjects, setFavoriteProjects] = useState<Array<{ name: string; timestamp: number }>>(() => {
    try {
      const stored = localStorage.getItem("kkcoder_favorite_projects");
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem("kkcoder_favorite_projects", JSON.stringify(favoriteProjects));
  }, [favoriteProjects]);

  // 记住项目最后访问时间（打开会话时更新），用于项目排序
  const [projectLastAccessed, setProjectLastAccessed] = useState<Record<string, number>>(() => {
    try {
      const stored = localStorage.getItem("kkcoder_project_last_accessed");
      return stored ? JSON.parse(stored) : {};
    } catch (e) {
      return {};
    }
  });

  useEffect(() => {
    localStorage.setItem("kkcoder_project_last_accessed", JSON.stringify(projectLastAccessed));
  }, [projectLastAccessed]);

  // 归档区状态
  const [showArchive, setShowArchive] = useState<boolean>(false);
  const [archivedProjects, setArchivedProjects] = useState<ArchivedProject[]>([]);
  const [archiveContextMenu, setArchiveContextMenu] = useState<{
    x: number;
    y: number;
    project: ArchivedProject;
  } | null>(null);
  const archiveSectionRef = useRef<HTMLDivElement>(null);

  // 点击归档区外部时自动收起归档区
  useEffect(() => {
    if (!showArchive) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (archiveSectionRef.current && !archiveSectionRef.current.contains(e.target as Node)) {
        setShowArchive(false);
      }
    };
    // 延迟添加监听，避免当前点击事件立即触发
    const timer = setTimeout(() => {
      window.addEventListener("mousedown", handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showArchive]);

  // 增加全局内容搜索相关的状态与防抖请求
  const [isContentSearch, setIsContentSearch] = useState<boolean>(false);
  const [contentSearchResults, setContentSearchResults] = useState<Record<string, string[]>>({});
  const [hoveredSession, setHoveredSession] = useState<{
    session: Session;
    top: number;
  } | null>(null);

  useEffect(() => {
    if (!isContentSearch || !searchQuery.trim()) {
      setContentSearchResults({});
      return;
    }

    const delayDebounceFn = setTimeout(() => {
      invoke<Array<{ sessionId: string; snippets: string[] }>>("search_session_contents", {
        query: searchQuery,
      })
        .then((results) => {
          const map: Record<string, string[]> = {};
          if (results) {
            results.forEach((r) => {
              map[r.sessionId] = r.snippets;
            });
          }
          setContentSearchResults(map);
        })
        .catch((err) => {
          console.error("Content search failed:", err);
        });
    }, 250); // 250ms 防抖

    return () => clearTimeout(delayDebounceFn);
  }, [searchQuery, isContentSearch]);

  // 加载归档项目列表
  const loadArchivedProjects = async () => {
    try {
      const data = await invoke<ArchivedProject[]>("get_archived_projects");
      setArchivedProjects(data);
    } catch (err) {
      console.error("Failed to load archived projects:", err);
    }
  };

  useEffect(() => {
    loadArchivedProjects();
  }, []);

  // 归档项目
  const handleArchiveProject = async (projectName: string, projectPath: string) => {
    try {
      // 收集该项目下的所有会话数据用于归档保存
      const projectSessions = sessions.filter(s => s.project === projectName);
      const sessionsJson = JSON.stringify(projectSessions);
      await invoke("archive_project", { projectName, projectPath, sessionsJson });
      // 删除该项目下的所有会话
      const sessionIds = projectSessions.map(s => s.id);
      if (sessionIds.length > 0) {
        onDeleteSessionsBatch(sessionIds);
      }
      loadArchivedProjects();
    } catch (err) {
      alert(`归档项目失败: ${err}`);
    }
  };

  // 还原归档项目
  const handleRestoreArchivedProject = async (id: number) => {
    try {
      const sessionsJson: string = await invoke("restore_archived_project", { id });
      // 解析归档时保存的会话数据并重建会话
      const archivedSessions: Session[] = JSON.parse(sessionsJson || "[]");
      for (const session of archivedSessions) {
        await invoke("add_session", { session: { ...session, deleted: 0, deletedAt: null } });
      }
      loadArchivedProjects();
      // 通知父组件重新加载会话列表
      if (archivedSessions.length > 0) {
        window.dispatchEvent(new CustomEvent("archive-sessions-restored"));
      }
    } catch (err) {
      alert(`还原项目失败: ${err}`);
    }
  };

  // 当 highlightSessionId 发生变化时，确保它隶属的项目文件夹处于展开状态
  useEffect(() => {
    if (highlightSessionId) {
      const session = sessions.find((s) => s.id === highlightSessionId);
      if (session) {
        setCollapsedProjects((prev) => prev.filter((p) => p !== session.project));
      }
    }
  }, [highlightSessionId, sessions]);

  // 2. 行内编辑会话名称状态
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState<string>("");
  const editInputRef = useRef<HTMLInputElement>(null);

  // 3. 右键自定义上下文菜单状态
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    session: Session;
  } | null>(null);

  // 3b. 项目右键上下文菜单状态
  const [projectContextMenu, setProjectContextMenu] = useState<{
    x: number;
    y: number;
    projectName: string;
    projectPath: string;
    sessionCount: number;
    isFavorited: boolean;
  } | null>(null);

  // 调整右键菜单位置，防止超出视口
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!contextMenu && !projectContextMenu) {
      setMenuPos(null);
      return;
    }
    const el = contextMenuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = (contextMenu?.x ?? projectContextMenu?.x) ?? 0;
    const y = (contextMenu?.y ?? projectContextMenu?.y) ?? 0;
    let top = y;
    let left = x;
    if (top + rect.height > window.innerHeight - 8) {
      top = window.innerHeight - rect.height - 8;
    }
    if (left + rect.width > window.innerWidth - 8) {
      left = window.innerWidth - rect.width - 8;
    }
    if (top !== y || left !== x) {
      setMenuPos({ top, left });
    }
  }, [contextMenu, projectContextMenu]);

  // 3c. 项目删除确认弹窗状态
  const [projectToDelete, setProjectToDelete] = useState<{
    projectName: string;
    sessionIds: string[];
  } | null>(null);

  // 点击外部自动关闭右键菜单（用 mousedown 确保标题栏拖拽前也能触发）
  useEffect(() => {
    const closeMenu = () => {
      setContextMenu(null);
      setProjectContextMenu(null);
    };
    window.addEventListener("mousedown", closeMenu);
    return () => window.removeEventListener("mousedown", closeMenu);
  }, []);

  // 滚动侧边栏时关闭右键菜单
  useEffect(() => {
    const sidebar = document.querySelector(".sidebar-scroll");
    if (!sidebar) return;
    const closeMenu = () => {
      setContextMenu(null);
      setProjectContextMenu(null);
    };
    sidebar.addEventListener("scroll", closeMenu);
    return () => sidebar.removeEventListener("scroll", closeMenu);
  }, []);

  // 监听关闭侧边栏右键菜单的事件（由标签页触发）
  useEffect(() => {
    const handleCloseSidebarContextMenu = () => {
      setContextMenu(null);
      setProjectContextMenu(null);
    };
    window.addEventListener("close-sidebar-context-menu", handleCloseSidebarContextMenu);
    return () => window.removeEventListener("close-sidebar-context-menu", handleCloseSidebarContextMenu);
  }, []);

  // 监听 ESC 键关闭移除确认弹窗
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setProjectToDelete(null);
      }
    };
    if (projectToDelete) {
      window.addEventListener("keydown", handleKeyDown, true);
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [projectToDelete]);

  // 监听 ESC 键关闭自定义确认弹窗
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConfirmState(null);
      }
    };
    if (confirmState) {
      window.addEventListener("keydown", handleKeyDown, true);
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [confirmState]);

  // 监听 ESC 键关闭回收站垃圾桶弹窗
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowTrashModal(false);
      }
    };
    if (showTrashModal) {
      window.addEventListener("keydown", handleKeyDown, true);
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [showTrashModal]);

  // 当进入编辑状态时，自动获得焦点并选中文本
  useEffect(() => {
    if (editingSessionId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSessionId]);

  const toggleProject = (projectName: string) => {
    setCollapsedProjects((prev) =>
      prev.includes(projectName)
        ? prev.filter((p) => p !== projectName)
        : [...prev, projectName]
    );
  };

  // 收藏/取消收藏整个项目
  const handleToggleFavoriteProject = (projectName: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setFavoriteProjects((prev) => {
      const exists = prev.some((p) => p.name === projectName);
      if (exists) {
        return prev.filter((p) => p.name !== projectName);
      } else {
        return [{ name: projectName, timestamp: Date.now() }, ...prev];
      }
    });
  };

  // 触发项目右键菜单
  const handleProjectContextMenu = (
    e: React.MouseEvent,
    projectName: string,
    projectPath: string,
    sessionsList: Session[],
    isFavorited: boolean
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu(null); // 关闭会话右键菜单
    setProjectContextMenu({
      x: e.clientX,
      y: e.clientY,
      projectName,
      projectPath,
      sessionCount: sessionsList.length,
      isFavorited,
    });
    // 触发事件关闭标签页右键菜单
    window.dispatchEvent(new CustomEvent("close-tab-context-menu"));
  };

  // 在文件管理器中物理打开项目路径
  const handleOpenProjectInExplorer = async (path: string) => {
    try {
      await invoke("open_project_folder", { path });
    } catch (err) {
      alert(`无法打开文件夹: ${err}`);
    }
  };

  // 4. 根据项目名称动态归类会话列表
  const projectsMap: { [key: string]: { path: string; sessions: Session[] } } = {};
  
  const filteredSessions = sessions.filter((s) => s.type === selectedAgent && s.deleted !== 1 && !s.isTemp);

  filteredSessions.forEach((s) => {
    const matchesTitle = searchQuery ? (
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.project.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.path.toLowerCase().includes(searchQuery.toLowerCase())
    ) : true;

    const matchedContentSnippets = isContentSearch ? contentSearchResults[s.id] : undefined;
    const matchesContent = !!matchedContentSnippets && matchedContentSnippets.length > 0;

    const isMatched = !searchQuery || matchesTitle || matchesContent;

    if (isMatched) {
      if (!projectsMap[s.project]) {
        projectsMap[s.project] = { path: s.path, sessions: [] };
      }
      const sessionWithSnippet = (matchedContentSnippets && matchedContentSnippets.length > 0)
        ? { ...s, matchSnippets: matchedContentSnippets } 
        : s;
      projectsMap[s.project].sessions.push(sessionWithSnippet);
    }
  });

  Object.values(projectsMap).forEach((project) => {
    project.sessions = sortSessionsByActivityDesc(project.sessions);
    // 当前活跃会话置顶（项目内排序后，将 activeSession 挪到最前面）
    if (activeSessionId) {
      const idx = project.sessions.findIndex((s) => s.id === activeSessionId);
      if (idx > 0) {
        const [active] = project.sessions.splice(idx, 1);
        project.sessions.unshift(active);
      }
    }
  });

  // 提取收藏的会话并附加匹配片段
  const favoriteSessions = sortSessionsByActivityDesc(
    filteredSessions
      .filter((s) => s.favorite === 1)
      .filter((s) => {
        const matchesTitle = searchQuery ? (
          s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.project.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.path.toLowerCase().includes(searchQuery.toLowerCase())
        ) : true;
        const matchedContentSnippets = isContentSearch ? contentSearchResults[s.id] : undefined;
        return !searchQuery || matchesTitle || (!!matchedContentSnippets && matchedContentSnippets.length > 0);
      })
      .map((s) => {
        const matchedContentSnippets = isContentSearch ? contentSearchResults[s.id] : undefined;
        return (matchedContentSnippets && matchedContentSnippets.length > 0) 
          ? { ...s, matchSnippets: matchedContentSnippets } 
          : s;
      })
  );

  // 打开会话时，更新该项目的最后访问时间（用于置顶排序）
  useEffect(() => {
    if (!activeSessionId) return;
    const session = sessions.find((s) => s.id === activeSessionId);
    if (!session?.project) return;
    setProjectLastAccessed((prev) => {
      if (prev[session.project] && Date.now() - prev[session.project] < 1000) return prev;
      return { ...prev, [session.project]: Date.now() };
    });
  }, [activeSessionId, sessions]);

  // 按最近访问时间 + 最近活跃会话自动排序项目
  const projectNames = Object.keys(projectsMap);
  const sortByAccessAndActivity = (names: string[]) => {
    return [...names].sort((a, b) => {
      const aAccess = projectLastAccessed[a] || 0;
      const bAccess = projectLastAccessed[b] || 0;
      if (aAccess !== bAccess) return bAccess - aAccess;
      // 回退到会话活跃时间
      const aSessions = projectsMap[a]?.sessions || [];
      const bSessions = projectsMap[b]?.sessions || [];
      const aTime = Math.max(0, ...aSessions.map((s) => getSessionActivityTimestamp(s)));
      const bTime = Math.max(0, ...bSessions.map((s) => getSessionActivityTimestamp(s)));
      return bTime - aTime;
    });
  };
  const favProjNames = useMemo(() => {
    const names = favoriteProjects
      .filter((fp) => projectNames.includes(fp.name))
      .map((fp) => fp.name);
    return sortByAccessAndActivity(names);
  }, [favoriteProjects, projectsMap, projectNames, projectLastAccessed]);
  const regularProjNames = projectNames.filter((name) => !favProjNames.includes(name));
  const regularSortedProjNames = useMemo(() => {
    return sortByAccessAndActivity(regularProjNames);
  }, [regularProjNames, projectsMap, projectLastAccessed]);

  const sortedProjectNames = [...favProjNames, ...regularSortedProjNames];

  // 6. 行内编辑操作
  const startEditing = (session: Session) => {
    setEditingSessionId(session.id);
    setEditingText(session.name);
  };

  const handleSaveEdit = (id: string) => {
    if (editingText.trim() && onRenameSession) {
      onRenameSession(id, editingText.trim());
    }
    setEditingSessionId(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent, id: string) => {
    if (e.key === "Enter") {
      handleSaveEdit(id);
    } else if (e.key === "Escape") {
      setEditingSessionId(null);
    }
  };

  // 7. 处理右键点击
  const handleItemContextMenu = (e: React.MouseEvent, session: Session) => {
    e.preventDefault();
    e.stopPropagation();
    setProjectContextMenu(null); // 关闭项目右键菜单
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      session,
    });
    // 触发事件关闭标签页右键菜单
    window.dispatchEvent(new CustomEvent("close-tab-context-menu"));
  };



  // 8. 统一会话行渲染函数 (复用在置顶收藏组和常规项目树中)
  const renderSessionRow = (session: Session) => {
    const isActive = activeSessionId === session.id;
    const isLoaded = openTabIds.includes(session.id); // 是否加载到了右边
    const isEditing = editingSessionId === session.id;
    const isHighlighted = highlightSessionId === session.id;
    const isGlowing = glowingSessionIds.includes(session.id);
    const isBusy = sessionBusy && sessionBusy[session.id];

    return (
      <li
        key={session.id}
        className={`session-item ${isActive ? "active" : ""} ${isHighlighted ? "highlight-flash" : ""}`}
        onClick={() => onSelectSession(session.id)}
        onDoubleClick={() => startEditing(session)}
        onContextMenu={(e) => handleItemContextMenu(e, session)}
        onAnimationEnd={() => {
          if (isHighlighted && onHighlightEnd) {
            onHighlightEnd();
          }
        }}
        onMouseEnter={(e) => {
          if (isContentSearch && searchQuery && session.matchSnippets && session.matchSnippets.length > 0) {
            const rect = e.currentTarget.getBoundingClientRect();
            setHoveredSession({
              session,
              top: rect.top,
            });
          }
        }}
        onMouseLeave={() => {
          setHoveredSession(null);
        }}
      >
        <div className="session-content">
          {/* 状态指示器：回答完成且非活动时展示黄色点提醒，否则：加载到右侧点亮(亮绿)，休眠状态(淡灰绿) */}
          <span 
            className={`status-indicator-dot ${isBusy ? "busy-pulse" : (isGlowing ? "glowing-yellow" : (isLoaded ? "lit" : "faded"))}`} 
            title={isBusy ? "正在思考..." : (isGlowing ? "回答完毕" : (isLoaded ? "会话处于活动状态" : "会话处于休眠状态"))}
          />
          
          {/* 橙色收藏小星星 (如果是收藏会话) */}
          {session.favorite === 1 && (
            <span className="favorite-star-badge" title="置顶收藏会话">⭐</span>
          )}

          {isEditing ? (
            <input
              ref={editInputRef}
              type="text"
              className="session-rename-input"
              value={editingText}
              onChange={(e) => setEditingText(e.target.value)}
              onBlur={() => handleSaveEdit(session.id)}
              onKeyDown={(e) => handleKeyDown(e, session.id)}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", flex: 1, minWidth: 0 }}>
              <span
                className={`session-name-text ${isGlowing ? "glowing-text" : ""}`}
                style={{
                  textOverflow: "ellipsis",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  fontSize: "12.5px"
                }}
                title={session.name}
              >
                {session.name}
              </span>
              {isContentSearch && searchQuery && session.matchSnippets && session.matchSnippets.length > 0 && (
                <span 
                  className="session-match-snippet"
                  style={{
                    fontSize: "10.5px",
                    color: isActive ? "rgba(255,255,255,0.6)" : "var(--text-muted)",
                    textOverflow: "ellipsis",
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    marginTop: "2px",
                    fontFamily: "var(--font-mono)",
                    letterSpacing: "-0.2px"
                  }}
                  title={session.matchSnippets[0]}
                >
                  {session.matchSnippets[0]}
                </span>
              )}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          {/* 时间标签 (如 2分钟前) */}
          <span className="session-time-tag">
            {formatRelativeSessionActivityTime(session)}
          </span>
          
          {/* 删除按钮 */}
          <button
            className="session-delete-btn"
            onClick={(e) => onDeleteSession(e, session.id)}
            title="永久删除此会话记录"
          >
            ×
          </button>
        </div>
      </li>
    );
  };

  const isFavoritesExist = favoriteSessions.length > 0;
  const isAllProjectsCollapsed = sortedProjectNames.every((p) => collapsedProjects.includes(p));
  const isFavoritesCollapsed = isFavoritesExist ? favoritesCollapsed : true;
  const allCollapsed = isAllProjectsCollapsed && isFavoritesCollapsed;

  const toggleCollapseAll = () => {
    if (sortedProjectNames.length === 0 && favoriteSessions.length === 0) return;
    
    if (allCollapsed) {
      // 展开全部
      setCollapsedProjects([]);
      if (isFavoritesExist) {
        setFavoritesCollapsed(false);
      }
    } else {
      // 收起全部
      setCollapsedProjects(sortedProjectNames);
      if (isFavoritesExist) {
        setFavoritesCollapsed(true);
      }
    }
  };

  return (
    <aside className="sidebar-aside" style={width !== undefined ? { width: `${width}px` } : undefined}>
      {/* 新建 AI 会话头部区域 */}
      <div className="sidebar-header">
        {/* Agent 选卡切换 */}
        <div className="agent-selector">
          <div className={`agent-selector-slider ${selectedAgent}`} />
          <button
            className={`agent-tab ${selectedAgent === "claude" ? "active claude-style" : ""}`}
            onClick={() => onSelectAgent("claude")}
            title="Claude Code"
          >
            <ClaudeIcon size={18} color={selectedAgent === "claude" ? "#D97757" : "var(--text-secondary)"} />
          </button>
          <button
            className={`agent-tab ${selectedAgent === "codex" ? "active codex-style" : ""}`}
            onClick={() => onSelectAgent("codex")}
            title="Codex"
          >
            <CodexIcon size={18} color={selectedAgent === "codex" ? "var(--color-green)" : "var(--text-secondary)"} />
          </button>
        </div>
        
        {/* 新建会话按钮、机器人按钮与回收站按钮 */}
        <div className="new-session-row" style={{ display: "flex", gap: "6px", width: "100%", marginBottom: "12px" }}>
          <button
            className="new-session-btn"
            style={{ flex: 1, margin: 0 }}
            onClick={() => onOpenNewSession()}
          >
            + 新建会话
          </button>
          <button
            className="sidebar-action-btn bot-btn"
            onClick={onOpenTempSession}
            title="新建无痕临时终端"
            style={{
              width: "28px",
              height: "28px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "var(--bg-active-item)",
              border: "1px solid var(--border-color)",
              borderRadius: "4px",
              color: "var(--text-secondary)",
              cursor: "pointer",
              transition: "var(--transition-smooth)",
              padding: 0,
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)"
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="10" rx="2"></rect>
              <circle cx="12" cy="5" r="2"></circle>
              <path d="M12 7v4M8 15h.01M16 15h.01"></path>
            </svg>
          </button>
          <button
            className="sidebar-action-btn trash-btn"
            onClick={() => setShowTrashModal(true)}
            title="回收站"
            style={{
              width: "28px",
              height: "28px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "var(--bg-active-item)",
              border: "1px solid var(--border-color)",
              borderRadius: "4px",
              color: "var(--text-secondary)",
              cursor: "pointer",
              transition: "var(--transition-smooth)",
              padding: 0,
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)"
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
          </button>
        </div>

        {/* 快速搜索框 */}
        <div className="search-container" style={{ display: "flex", alignItems: "center", position: "relative" }}>
          <svg
            className="search-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            type="text"
            className={`search-input ${selectedAgent === "codex" ? "codex-focus" : ""}`}
            style={{ paddingRight: "34px" }}
            placeholder={isContentSearch ? "✨ 全局搜索聊天记录内容..." : "搜索本地会话项目..."}
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
          />
          <button
            className={`search-enhance-btn ${isContentSearch ? "active" : ""}`}
            onClick={() => setIsContentSearch(!isContentSearch)}
            title={isContentSearch ? "切换为普通标题搜索" : "全局聊天内容搜索 (✨)"}
            style={{
              position: "absolute",
              right: "8px",
              top: "50%",
              transform: "translateY(-50%)",
              background: "none",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: isContentSearch ? "var(--color-primary)" : "var(--text-secondary)",
              transition: "var(--transition-smooth)",
              padding: "4px",
              borderRadius: "4px"
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              <line x1="8" y1="9" x2="14" y2="9"></line>
              <line x1="8" y1="13" x2="12" y2="13"></line>
            </svg>
          </button>
        </div>
      </div>

      {/* 滚动会话树列表 */}
      <div className="sidebar-scroll">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingRight: "12px", marginBottom: "8px" }}>
          <div className="section-title" style={{ marginBottom: 0 }}>会话管理</div>
          <button 
            className="collapse-all-btn"
            onClick={toggleCollapseAll}
            disabled={sortedProjectNames.length === 0 && favoriteSessions.length === 0}
            title={allCollapsed ? "展开全部" : "收起全部"}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-secondary)",
              cursor: (sortedProjectNames.length === 0 && favoriteSessions.length === 0) ? "not-allowed" : "pointer",
              padding: "2px 4px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "var(--radius-sm)",
              transition: "var(--transition-smooth)",
              opacity: (sortedProjectNames.length === 0 && favoriteSessions.length === 0) ? 0.3 : 1,
            }}
            onMouseEnter={(e) => {
              if (sortedProjectNames.length > 0 || favoriteSessions.length > 0) {
                e.currentTarget.style.color = "var(--text-primary)";
                e.currentTarget.style.backgroundColor = "var(--bg-hover-item)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-secondary)";
              e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            {allCollapsed ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m7 13 5 5 5-5"/>
                <path d="m7 6 5 5 5-5"/>
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m17 11-5-5-5 5"/>
                <path d="m17 18-5-5-5 5"/>
              </svg>
            )}
          </button>
        </div>

        {/* 置顶 “⭐ 收藏” 分组 (如果有被收藏的会话) */}
        {favoriteSessions.length > 0 && (
          <div className="project-group favorite-group-wrapper" style={{ marginBottom: "12px" }}>
            <div 
              className="project-header favorite-group-header" 
              onClick={() => setFavoritesCollapsed(!favoritesCollapsed)}
              style={{ cursor: "pointer", userSelect: "none" }}
            >
              <div className="project-title favorite-group-title">
                <span className="project-chevron" style={{ transform: favoritesCollapsed ? "rotate(-90deg)" : "rotate(0deg)" }}>
                  ▼
                </span>
                <span style={{ color: "var(--color-orange)", fontWeight: 700 }}>★ 收藏</span>
              </div>
              <span className="project-session-count" style={{ backgroundColor: "var(--color-orange-light)", color: "var(--color-orange)" }}>
                {favoriteSessions.length}
              </span>
            </div>
            
            {!favoritesCollapsed && (() => {
              const visibleSessions = favoritesExpanded ? favoriteSessions : favoriteSessions.slice(0, 5);
              const hiddenCount = favoriteSessions.length - 5;
              return (
                <>
                  <ul className="session-list" style={{ padding: "2px" }}>
                    {visibleSessions.map((session) => renderSessionRow(session))}
                  </ul>
                  {hiddenCount > 0 && (
                    <div
                      className="expand-collapse-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFavoritesExpanded(!favoritesExpanded);
                      }}
                    >
                      {favoritesExpanded ? "收起" : `展开更多 (${hiddenCount})`}
                    </div>
                  )}
                </>
              );
            })()}
            <div className="favorite-divider" style={{ borderBottom: "1px dashed var(--border-color)", margin: "8px 4px 4px 4px" }} />
          </div>
        )}

        {/* 常规项目与会话树 */}
        {sortedProjectNames.length === 0 ? (
          <div style={{ padding: "20px 8px", fontSize: "12px", color: "var(--text-secondary)", textAlign: "center" }}>
            暂无活动会话
          </div>
        ) : (
          sortedProjectNames.map((projName) => {
            const proj = projectsMap[projName];
            if (!proj) return null;
            const isCollapsed = collapsedProjects.includes(projName);
            const isProjectFavorited = favoriteProjects.some((fp) => fp.name === projName);
            return (
              <div
                key={projName}
                data-project-name={projName}
                className="project-group"
              >
                {/* 项目层级标题 */}
                <div
                  className="project-header"
                  onClick={() => toggleProject(projName)}
                  onContextMenu={(e) => handleProjectContextMenu(e, projName, proj.path, proj.sessions, isProjectFavorited)}
                  style={{ cursor: "pointer", userSelect: "none" }}
                >
                  <div className="project-title">
                    <span className="project-chevron" style={{ transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)" }}>
                      ▼
                    </span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <span 
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleFavoriteProject(projName, e);
                        }}
                        className="project-folder-toggle"
                        style={{ display: "inline-flex", alignItems: "center", cursor: "pointer" }}
                        title={isProjectFavorited ? "取消收藏" : "收藏项目"}
                      >
                        <svg
                          className="folder-svg-icon"
                          xmlns="http://www.w3.org/2000/svg"
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke={isProjectFavorited ? "var(--color-primary)" : "var(--text-secondary)"}
                          strokeWidth="2.0"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          style={{ opacity: 0.95, transition: "stroke 0.15s ease" }}
                        >
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                        </svg>
                      </span>
                      <span title={proj.path}>{projName}</span>
                    </span>
                    {isProjectFavorited && (
                      <span className="project-star-badge" style={{ color: "#f59e0b", marginLeft: "4px" }}>★</span>
                    )}
                  </div>
                  
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }} onClick={(e) => e.stopPropagation()}>
                    <span className="project-session-count">
                      {proj.sessions.length}
                    </span>
                  </div>
                </div>
                
                {/* 会话列表 */}
                {!isCollapsed && (() => {
                  const isExpanded = expandedProjects.includes(projName);
                  const visibleSessions = isExpanded ? proj.sessions : proj.sessions.slice(0, 5);
                  const hiddenCount = proj.sessions.length - 5;
                  return (
                    <>
                      <ul className="session-list" style={{ padding: "2px" }}>
                        {visibleSessions.map((session) => renderSessionRow(session))}
                      </ul>
                      {hiddenCount > 0 && (
                        <div
                          className="expand-collapse-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedProjects((prev) =>
                              prev.includes(projName) ? prev.filter((p) => p !== projName) : [...prev, projName]
                            );
                          }}
                        >
                          {isExpanded ? "收起" : `展开更多 (${hiddenCount})`}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            );
          })
        )}
      </div>

      {/* 归档区 */}
      <div className="archive-section" ref={archiveSectionRef}>
        <div 
          className="archive-header"
          onClick={() => setShowArchive(!showArchive)}
          style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderTop: "1px solid var(--border-color)", backgroundColor: "var(--bg-sidebar)" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="21 8 21 21 3 21 3 8"></polyline>
              <rect x="1" y="3" width="22" height="5"></rect>
              <line x1="10" y1="12" x2="14" y2="12"></line>
            </svg>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)" }}>归档区</span>
            <span style={{ fontSize: "11px", color: "var(--text-secondary)", backgroundColor: "rgba(0,0,0,0.05)", padding: "1px 6px", borderRadius: "10px" }}>{archivedProjects.length}</span>
          </div>
          <span className="project-chevron" style={{ transform: showArchive ? "rotate(0deg)" : "rotate(-90deg)", fontSize: "9px", color: "var(--text-secondary)" }}>▼</span>
        </div>

        {showArchive && (
          <div className="archive-content" style={{ maxHeight: "200px", overflowY: "auto" }}>
            {archivedProjects.length === 0 ? (
              <div style={{ padding: "12px", fontSize: "12px", color: "var(--text-secondary)", textAlign: "center" }}>
                暂无归档项目
              </div>
            ) : (
              Object.entries(
                archivedProjects.reduce((acc, proj) => {
                  if (!acc[proj.archive_month]) acc[proj.archive_month] = [];
                  acc[proj.archive_month].push(proj);
                  return acc;
                }, {} as Record<string, ArchivedProject[]>)
              ).map(([month, projects]) => (
                <div key={month} className="archive-month-group">
                  <div style={{ padding: "4px 12px", fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", backgroundColor: "var(--bg-active-item)", borderBottom: "1px solid var(--border-color)" }}>
                    {month}
                  </div>
                  {projects.map((proj) => (
                    <div 
                      key={proj.id} 
                      className="archive-item"
                      style={{ padding: "6px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", transition: "var(--transition-smooth)" }}
                      onClick={() => {
                        setConfirmState({
                          show: true,
                          title: "还原项目",
                          message: (
                            <>
                              确定要将项目「<strong style={{ color: "var(--color-orange)" }}>{proj.project_name}</strong>」还原到工作区吗？
                            </>
                          ),
                          onConfirm: () => {
                            handleRestoreArchivedProject(proj.id);
                            setConfirmState(null);
                          }
                        });
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setArchiveContextMenu({ x: e.clientX, y: e.clientY, project: proj });
                      }}
                      title={proj.project_path}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                        </svg>
                        <span style={{ fontSize: "12px", color: "var(--text-primary)", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{proj.project_name}</span>
                      </div>
                      <span style={{ fontSize: "10px", color: "var(--text-secondary)" }} title="点击还原到工作区">还原</span>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* 归档项目右键菜单 */}
      {archiveContextMenu && (
        <div 
          className="context-menu"
          style={{ top: archiveContextMenu.y, left: archiveContextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button 
            className="context-menu-item"
            onClick={() => {
              handleRestoreArchivedProject(archiveContextMenu.project.id);
              setArchiveContextMenu(null);
            }}
          >
            还原到工作区
          </button>
          <button 
            className="context-menu-item"
            onClick={() => {
              navigator.clipboard.writeText(archiveContextMenu.project.project_path).catch(() => {});
              setArchiveContextMenu(null);
            }}
          >
            复制路径
          </button>
        </div>
      )}

      {/* 9. 自定义高档白天右键上下文悬浮菜单 */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{
            top: menuPos?.top ?? contextMenu.y,
            left: menuPos?.left ?? contextMenu.x
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button 
            className="context-menu-item"
            onClick={() => {
              if (onToggleFavorite) {
                onToggleFavorite(contextMenu.session.id, contextMenu.session.favorite !== 1);
              }
              setContextMenu(null);
            }}
          >
            {contextMenu.session.favorite === 1 ? "取消收藏" : "收藏"}
          </button>
          
          <div className="context-menu-divider" style={{ height: "1px", backgroundColor: "var(--border-color)", margin: "4px 0" }}></div>

          <button 
            className="context-menu-item"
            onClick={() => {
              startEditing(contextMenu.session);
              setContextMenu(null);
            }}
          >
            重命名
          </button>

          <div className="context-menu-divider" style={{ height: "1px", backgroundColor: "var(--border-color)", margin: "4px 0" }}></div>

          <button
            className="context-menu-item"
            onClick={() => {
              navigator.clipboard.writeText(contextMenu.session.agentSessionId).catch(() => {});
              setContextMenu(null);
            }}
          >
            复制 Session ID
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              navigator.clipboard.writeText(contextMenu.session.path).catch(() => {});
              setContextMenu(null);
            }}
          >
            复制项目路径
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              invoke("open_project_folder", { path: contextMenu.session.path }).catch(() => {});
              setContextMenu(null);
            }}
          >
            在文件管理器中打开
          </button>

          <button
            className="context-menu-item"
            style={{ color: "#ef4444" }}
            onClick={() => {
              setSessionToDelete(contextMenu.session);
              setContextMenu(null);
            }}
          >
            删除
          </button>
        </div>
      )}

      {/* 项目右键上下文悬浮菜单 */}
      {projectContextMenu && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{
            top: menuPos?.top ?? projectContextMenu.y,
            left: menuPos?.left ?? projectContextMenu.x
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button 
            className="context-menu-item"
            onClick={() => {
              if (onCreateSessionDirectly) {
                onCreateSessionDirectly(projectContextMenu.projectPath);
              } else {
                onOpenNewSession(projectContextMenu.projectPath);
              }
              setProjectContextMenu(null);
            }}
          >
            新建会话
          </button>
          <div style={{ borderBottom: "1px dashed var(--border-color)", margin: "4px 6px" }} />
          <button 
            className="context-menu-item"
            onClick={(e) => {
              handleToggleFavoriteProject(projectContextMenu.projectName, e);
              setProjectContextMenu(null);
            }}
          >
            {projectContextMenu.isFavorited ? "取消收藏项目" : "收藏项目"}
          </button>
          <button 
            className="context-menu-item"
            onClick={() => {
              handleOpenProjectInExplorer(projectContextMenu.projectPath);
              setProjectContextMenu(null);
            }}
          >
            在文件管理器中打开
          </button>
          <button 
            className="context-menu-item"
            onClick={() => {
              navigator.clipboard.writeText(projectContextMenu.projectPath).then(() => {
                // 静默复制成功
              }).catch(() => {
                alert("复制路径失败");
              });
              setProjectContextMenu(null);
            }}
          >
            复制路径
          </button>
          <button 
            className="context-menu-item"
            onClick={() => {
              handleArchiveProject(projectContextMenu.projectName, projectContextMenu.projectPath);
              setProjectContextMenu(null);
            }}
          >
            归档项目
          </button>
          <div style={{ borderBottom: "1px dashed var(--border-color)", margin: "4px 6px" }} />
          <button 
            className="context-menu-item"
            style={{ color: "#ef4444" }}
            onClick={() => {
              const proj = projectsMap[projectContextMenu.projectName];
              if (proj) {
                const ids = proj.sessions.map((s) => s.id);
                setProjectToDelete({
                  projectName: projectContextMenu.projectName,
                  sessionIds: ids,
                });
              }
              setProjectContextMenu(null);
            }}
          >
            移除整个目录
          </button>
        </div>
      )}

      {/* 移除目录确认弹窗 */}
      {projectToDelete && (
        <div className="modal-overlay show" onClick={() => setProjectToDelete(null)}>
          <div className="modal-card" style={{ maxWidth: "420px" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">移除整个目录</span>
              <button className="modal-close" onClick={() => setProjectToDelete(null)}>×</button>
            </div>
            
            <div style={{ fontSize: "13.5px", lineHeight: "1.6", color: "var(--text-primary)" }}>
              确定要移除该目录「<strong style={{ color: "var(--color-orange)" }}>{projectToDelete.projectName}</strong>」下的 <strong style={{ color: "var(--color-orange)", fontSize: "14.5px" }}>{projectToDelete.sessionIds.length}</strong> 个会话吗？
              <br />
              <span style={{ fontSize: "12px", color: "var(--text-secondary)", display: "inline-block", marginTop: "10px" }}>
                ⚠️ 此操作仅删除应用中的会话记录，不会删除磁盘上的原始文件。
              </span>
            </div>
            
            <div className="modal-footer">
              <button className="modal-btn modal-btn-cancel" onClick={() => setProjectToDelete(null)}>
                取消
              </button>
              <button 
                className="modal-btn modal-btn-create" 
                style={{ backgroundColor: "#ef4444", color: "#fff", boxShadow: "0 2px 4px rgba(239, 68, 68, 0.2)" }}
                onClick={() => {
                  onDeleteSessionsBatch(projectToDelete.sessionIds);
                  setProjectToDelete(null);
                }}
              >
                移除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 确认删除会话弹窗 */}
      {sessionToDelete && (
        <div className="modal-overlay show" style={{ zIndex: 1100 }} onClick={() => setSessionToDelete(null)}>
          <div className="modal-card" style={{ maxWidth: "380px", padding: "20px" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
              <span style={{ 
                display: "inline-flex", 
                alignItems: "center", 
                justifyContent: "center", 
                width: "24px", 
                height: "24px", 
                borderRadius: "50%", 
                backgroundColor: "#fef3c7", 
                color: "#d97706",
                fontSize: "14px",
                fontWeight: "bold",
                flexShrink: 0
              }}>
                !
              </span>
              <div style={{ flex: 1 }}>
                <h3 style={{ margin: "0 0 8px 0", fontSize: "14.5px", fontWeight: 700, color: "var(--text-primary)" }}>确认删除</h3>
                <p style={{ margin: 0, fontSize: "12.5px", color: "var(--text-secondary)", lineHeight: "1.5" }}>
                  确定要删除该会话吗？删除后将移入回收站。
                </p>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "20px" }}>
              <button 
                className="modal-btn modal-btn-cancel" 
                onClick={() => setSessionToDelete(null)}
              >
                取 消
              </button>
              <button 
                className="modal-btn modal-btn-create" 
                style={{ backgroundColor: "#ef4444", color: "#fff", boxShadow: "0 2px 4px rgba(239, 68, 68, 0.2)" }}
                onClick={() => {
                  onDeleteSession(null, sessionToDelete.id);
                  setSessionToDelete(null);
                }}
              >
                删 除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🗑️ 回收站垃圾桶弹窗 */}
      {showTrashModal && (() => {
        const deletedSessions = sessions.filter((s) => s.deleted === 1 && s.type === selectedAgent);
        return (
          <div className="modal-overlay show" style={{ zIndex: 1100 }} onClick={() => setShowTrashModal(false)}>
            <div className="modal-card trash-modal-card" style={{ maxWidth: "480px", width: "100%" }} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    <line x1="10" y1="11" x2="10" y2="17"></line>
                    <line x1="14" y1="11" x2="14" y2="17"></line>
                  </svg>
                  垃圾桶
                  <span className="trash-count-badge">
                    {deletedSessions.length} 项
                  </span>
                </span>
                <button className="modal-close" onClick={() => setShowTrashModal(false)}>×</button>
              </div>

              <div className="trash-session-list">
                {deletedSessions.length === 0 ? (
                  <div className="trash-empty-placeholder">
                    垃圾桶空空如也
                  </div>
                ) : (
                  deletedSessions.map((s) => (
                    <div key={s.id} className="trash-session-item">
                      <div className="trash-item-info">
                        <div className="trash-item-name" title={s.name}>
                          {s.name}
                        </div>
                        <div className="trash-item-meta">
                          <span className="trash-item-project">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                            </svg>
                            {s.project}
                          </span>
                          <span className="trash-item-expiry">
                            7天后删除
                          </span>
                        </div>
                      </div>
                      <div className="trash-item-actions">
                        <button
                          title="恢复会话"
                          onClick={() => onRestoreSession(s.id)}
                          className="trash-action-btn recover"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                          </svg>
                        </button>
                        <button
                          title="彻底删除"
                          onClick={() => {
                            setConfirmState({
                              show: true,
                              title: "彻底删除会话",
                              message: "确定要永久删除该会话吗？此操作不可逆。",
                              isDanger: true,
                              onConfirm: () => {
                                onPermanentlyDeleteSession(s.id);
                                setConfirmState(null);
                              }
                            });
                          }}
                          className="trash-action-btn hard-delete"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            <line x1="10" y1="11" x2="10" y2="17"></line>
                            <line x1="14" y1="11" x2="14" y2="17"></line>
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="modal-footer trash-modal-footer">
                <span className="trash-expiry-tip">
                  超过 7 天自动永久删除
                </span>
                {deletedSessions.length > 0 && (
                  <button 
                    className="trash-empty-btn"
                    onClick={() => {
                      setConfirmState({
                        show: true,
                        title: "清空垃圾桶",
                        message: "确定要清空垃圾桶中的所有已删除会话吗？此操作不可逆。",
                        isDanger: true,
                        onConfirm: () => {
                          onEmptyTrash();
                          setConfirmState(null);
                        }
                      });
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                    清空垃圾桶
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 全局内容搜索悬浮卡片面板 */}
      {hoveredSession && (
        <div 
          className="search-match-popover"
          style={{
            position: "fixed",
            left: `${(width !== undefined ? width : 300) + 8}px`,
            top: `${hoveredSession.top}px`,
            zIndex: 2000,
            width: "320px",
            backgroundColor: "var(--bg-sidebar)",
            backdropFilter: "blur(8px)",
            border: "1px solid var(--border-color)",
            borderRadius: "var(--radius-md)",
            boxShadow: "0 6px 16px rgba(0, 0, 0, 0.4), 0 2px 4px rgba(0, 0, 0, 0.2)",
            padding: "10px 12px",
            animation: "fadeInSmooth 0.15s cubic-bezier(0.16, 1, 0.3, 1)",
            pointerEvents: "none",
          }}
        >
          <div style={{
            fontSize: "11px",
            fontWeight: 700,
            color: "var(--text-secondary)",
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            marginBottom: "8px",
            borderBottom: "1px solid var(--border-color)",
            paddingBottom: "6px"
          }}>
            ✨ 匹配记录 (最多展示 3 条)
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {hoveredSession.session.matchSnippets?.slice(0, 3).map((snippet, idx) => (
              <div 
                key={idx} 
                style={{
                  fontSize: "11.5px",
                  color: "var(--text-primary)",
                  lineHeight: "1.5",
                  fontFamily: "var(--font-mono)",
                  wordBreak: "break-all",
                  paddingBottom: idx < 2 && idx < (hoveredSession.session.matchSnippets?.length || 0) - 1 ? "8px" : "0",
                  borderBottom: idx < 2 && idx < (hoveredSession.session.matchSnippets?.length || 0) - 1 ? "1px dashed var(--border-color)" : "none"
                }}
              >
                {highlightKeyword(snippet, searchQuery)}
              </div>
            ))}
          </div>
        </div>
      )}
      {confirmState && (
        <ConfirmModal
          show={confirmState.show}
          title={confirmState.title}
          message={confirmState.message}
          isDanger={confirmState.isDanger}
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      )}
    </aside>
  );
};

const escapeRegExp = (str: string) => {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const highlightKeyword = (text: string, keyword: string) => {
  if (!keyword) return text;
  try {
    const parts = text.split(new RegExp(`(${escapeRegExp(keyword)})`, "gi"));
    return parts.map((part, index) => 
      part.toLowerCase() === keyword.toLowerCase()
        ? <strong key={index} style={{ color: "var(--color-primary)", fontWeight: 600 }}>{part}</strong>
        : part
    );
  } catch (e) {
    return text;
  }
};
