import express from "express";

import { expressSensor } from "@crawlytics/sensor-node";

const app = express();
const port = Number(process.env["PORT"] ?? 3001);

app.use(
  expressSensor({
    key: process.env["CRAWLYTICS_KEY"] ?? "dev-key",
    url: process.env["CRAWLYTICS_URL"] ?? "http://localhost:3000"
  })
);

app.get("/", (_req, res) => {
  res.send("ok");
});

app.listen(port, () => {
  console.log(`Example app listening on http://localhost:${String(port)}`);
});
