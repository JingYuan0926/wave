import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { BatteryFull, Signal, Wifi } from "lucide-react";

/** iPhone 16 screen in points. */
export const IPHONE_16 = { width: 393, height: 852, safeTop: 54, safeBottom: 34, radius: 55 };

const BEZEL = 12;
const MARGIN = 32;

/**
 * Shows the app at exact iPhone 16 size. When the window is smaller than the
 * phone, the whole phone scales down evenly so proportions stay true.
 */
export function PhoneFrame({ children }: { children: ReactNode }) {
  const { width: W, height: H } = IPHONE_16;
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const fit = () =>
      setScale(
        Math.min(1, (window.innerHeight - MARGIN * 2) / (H + BEZEL * 2), (window.innerWidth - MARGIN * 2) / (W + BEZEL * 2)),
      );
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [W, H]);

  // transform: scale() does not change layout size. The outer box takes the scaled size, so the
  // page never holds an 852 px phone in a shorter window. overflow-clip (not hidden) also stops
  // focus() and scrollIntoView from scrolling the frame.
  return (
    <div className="flex h-dvh items-center justify-center overflow-clip">
      <div className="relative shrink-0" style={{ width: W * scale, height: H * scale }}>
        <div
          className="absolute left-0 top-0 overflow-clip bg-page"
          style={
            {
              width: W,
              height: H,
              borderRadius: IPHONE_16.radius,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
              boxShadow: `0 0 0 ${BEZEL}px #0a0a0a, 0 40px 90px -20px rgba(0,0,0,0.5)`,
              "--nav-bottom": `${IPHONE_16.safeBottom - 8}px`,
            } as CSSProperties
          }
        >
          <StatusBar />
          <div className="absolute inset-x-0 bottom-0 overflow-clip" style={{ top: IPHONE_16.safeTop }}>
            {children}
          </div>
          <div className="pointer-events-none absolute bottom-2 left-1/2 z-[60] h-[5px] w-36 -translate-x-1/2 rounded-full bg-ink" aria-hidden />
        </div>
      </div>
    </div>
  );
}

function StatusBar() {
  return (
    <div
      className="absolute inset-x-0 top-0 z-40 flex items-center justify-between bg-page px-8 pt-1"
      style={{ height: IPHONE_16.safeTop }}
      aria-hidden
    >
      <span className="w-14 text-center text-[17px] font-semibold">9:41</span>
      <span className="absolute left-1/2 top-[11px] h-[37px] w-[126px] -translate-x-1/2 rounded-full bg-black" />
      <span className="flex items-center gap-1.5">
        <Signal className="size-[18px]" strokeWidth={2.6} />
        <Wifi className="size-[18px]" strokeWidth={2.6} />
        <BatteryFull className="size-6" strokeWidth={1.8} />
      </span>
    </div>
  );
}
