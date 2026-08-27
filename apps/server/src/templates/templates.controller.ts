import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import {
  createTemplateSchema,
  setTemplateItemsSchema,
  updateTemplateSchema,
  type CreateTemplateRequest,
  type SetTemplateItemsRequest,
  type UpdateTemplateRequest,
} from '@eat/shared';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { TemplatesService } from './templates.service';

@Controller('api/templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.templates.list(user);
  }

  @Post()
  @Roles('admin')
  create(@Body(new ZodValidationPipe(createTemplateSchema)) body: CreateTemplateRequest, @CurrentUser() user: AuthUser) {
    return this.templates.create(user, body);
  }

  @Patch(':id')
  @Roles('admin')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTemplateSchema)) body: UpdateTemplateRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.templates.update(user, id, body);
  }

  @Delete(':id')
  @Roles('admin')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.templates.remove(user, id);
  }

  @Put(':id/items')
  @Roles('admin')
  setItems(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setTemplateItemsSchema)) body: SetTemplateItemsRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.templates.setItems(user, id, body);
  }

  @Post(':id/select')
  select(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.templates.select(user, id);
  }

  @Post('deselect')
  deselect(@CurrentUser() user: AuthUser) {
    return this.templates.deselect(user);
  }
}
