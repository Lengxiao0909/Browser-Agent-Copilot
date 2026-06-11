import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '../../../generated/prisma/index.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
