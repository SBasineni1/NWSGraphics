import { ImageResponse } from "next/og";

export const alt = "PHI Forecast Graphics";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          overflow: "hidden",
          color: "#f7f7f5",
          background: "#0a0b0d",
          fontFamily: "Arial, Helvetica, sans-serif",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 30,
            display: "flex",
            border: "1px solid #30343a",
            borderRadius: 28,
          }}
        />
        <div
          style={{
            width: 360,
            margin: "30px 0 30px 30px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRight: "1px solid #30343a",
          }}
        >
          <div
            style={{
              width: 190,
              height: 190,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
              border: "1px solid #444a53",
              borderRadius: 34,
              background: "#111317",
              fontSize: 66,
              fontWeight: 700,
              letterSpacing: "-5px",
            }}
          >
            <div style={{ position: "absolute", left: 28, top: 24, width: 3, height: 142, display: "flex", background: "#168cff" }} />
            <div style={{ position: "absolute", right: 28, top: 24, width: 3, height: 142, display: "flex", background: "#168cff" }} />
            <div style={{ position: "absolute", right: 23, bottom: 19, width: 13, height: 13, display: "flex", borderRadius: 999, background: "#f05a16" }} />
            PHI
          </div>
        </div>
        <div
          style={{
            flex: 1,
            padding: "0 76px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          <div style={{ display: "flex", color: "#8f969f", fontSize: 24, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase" }}>
            Public weather graphics
          </div>
          <div style={{ display: "flex", marginTop: 22, fontSize: 68, lineHeight: 1.02, fontWeight: 700, letterSpacing: "-0.055em" }}>
            PHI Forecast<br />Graphics
          </div>
          <div style={{ display: "flex", marginTop: 30, color: "#a7adb5", fontSize: 28 }}>
            Day 1–3 forecasts for the Mount Holly area
          </div>
        </div>
        <div style={{ position: "absolute", left: 60, bottom: 51, display: "flex", color: "#7f8791", fontSize: 18, letterSpacing: "0.08em" }}>
          NWS DATA · CONTINUOUSLY UPDATED
        </div>
      </div>
    ),
    size,
  );
}
