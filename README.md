Per scenario threshold:

```yaml
config:
  target: "https://www.artillery.io"
  plugins:
    scenario-threshold: {}
  phases:
    - duration: 10
      arrivalRate: 1
  scenario-threshold:
    thresholdPerEndpointEnabled: true
scenarios:
  - name: 'root'
    thresholds:
      - engine.http.response_time.p95: 1000
    flow:
      - get:
          url: "/"
  - name: 'docs'
    thresholds:
      - engine.http.response_time.p95: 1500
    flow:
      - get:
          url: "/docs"
  - name: 'integration'
    thresholds:
      - engine.http.response_time.p95: 2000
    flow:
      - get:
          url: "/integration"
```

## License

MPL 2.0
