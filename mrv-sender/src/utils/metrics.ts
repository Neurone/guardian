import express from 'express';
import client from 'prom-client';
// import guardianServicePrometheusMetrics from 'prometheus-api-metrics';

const app = express();

const PORT = process.env.PORT || 5008;

export const startMetricsServer = () => {
  //TODO: fix crush app read from undefined
  // app.use(guardianServicePrometheusMetrics());
  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', client.register.contentType);
    
    client.collectDefaultMetrics()

    return res.send(await client.register.metrics());
  });

  app.listen(PORT, () => {
    console.log(`mrv-sender metrics server started at http://localhost:${PORT}`);
  });
}
