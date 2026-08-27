import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/** 用法: @Body(new ZodValidationPipe(schema))，校验失败统一返回 VALIDATION_FAILED */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        error: 'VALIDATION_FAILED',
        message: '请求参数不合法',
        details: result.error.issues,
      });
    }
    return result.data;
  }
}
