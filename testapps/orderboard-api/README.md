# orderboard-api

An orders dashboard where the **API and the database own the data**. The admin
page in `src/web/` is a thin client: it fetches from the API and renders what
comes back. It stores nothing.

That split is the point of this test app. In a browser-only app the UI *is* the
product, so driving the browser exercises every layer. Here, a browser check
that passes tells you very little about the routes, the migrations or the
queries underneath it. A verification that only looks at the page is looking
at the part that was never at risk.

## Running it

```bash
npm run migrate   # apply src/migrations/*.sql, in order, once each
npm run seed      # insert the sample orders
npm start         # http://localhost:3001
npm test
```

Sign in at `/` with **admin** or **viewer**; the session is a bearer token
held in memory. There is no third dependency to install: `node:http`,
`node:sqlite` and `node:test` all ship with Node.

## What is deliberately NOT here

There is no CSV export. That is the feature a run builds.
