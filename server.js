'use strict';

const { createApp } = require('./src/app');

const port = Number(process.env.PORT) || 3000;
const app = createApp();

app.listen(port, () => {
  console.log(`${app.locals.siteName} 已啟動：http://localhost:${port}`);
});
