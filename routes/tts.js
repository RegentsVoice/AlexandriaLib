const { requireAuth } = require("../auth");
const { PYTHON_PORT } = require("../lib/config");

function registerTtsRoutes(app) {
  app.use("/api/tts", requireAuth, async (req, res) => {
    const rawUrl = req.url || "/";
    const qIdx = rawUrl.indexOf("?");
    const targetPath = (qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl) || "/";
    const query = qIdx >= 0 ? rawUrl.slice(qIdx) : "";
    const target = "http://127.0.0.1:" + PYTHON_PORT + targetPath + query;

    try {
      const fetchOpts = {
        method: req.method,
        headers: {
          "content-type": "application/json",
          accept: "application/json, audio/wav, */*",
        },
      };

      if (req.method !== "GET" && req.method !== "HEAD") {
        const body =
          req.body && typeof req.body === "object" ? req.body : {};
        fetchOpts.body = JSON.stringify(body);
      }

      const response = await fetch(target, fetchOpts);
      const contentType = response.headers.get("content-type") || "";

      res.status(response.status);

      if (contentType.includes("audio") || contentType.includes("octet-stream")) {
        const buf = Buffer.from(await response.arrayBuffer());
        res.set("Content-Type", contentType || "audio/wav");
        const cache = response.headers.get("X-Cache");
        if (cache) res.set("X-Cache", cache);
        return res.send(buf);
      }

      const textBody = await response.text();
      res.set("Content-Type", contentType || "application/json");
      return res.send(textBody);
    } catch (err) {
      console.error("Proxy error:", err.message);
      return res.status(502).json({
        error: "TTS server unavailable",
        detail: err.message,
      });
    }
  });
}

module.exports = { registerTtsRoutes };
