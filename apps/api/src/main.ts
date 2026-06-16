import 'reflect-metadata';
import './config/env.js';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './modules/app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  app.enableCors({
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  });

  const port = Number(process.env.API_PORT || 3001);
  await app.listen(port);
  console.log(`Browser Agent Copilot API listening on http://localhost:${port}`);
}

void bootstrap();
