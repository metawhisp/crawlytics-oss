# Crawlytics Express Sensor Example

Minimal Express wiring for the fail-open Node sensor.

```sh
CRAWLYTICS_URL=http://localhost:3000 CRAWLYTICS_KEY=dev-key tsx server.ts
```

The middleware calls `next()` immediately and reports completed responses in the background.
