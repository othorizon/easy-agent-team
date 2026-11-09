import { Controller, Header, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators';
import { AliyunCredentialsService } from './aliyun-credentials.service';

@Controller('api/aliyun/connections')
export class AliyunCredentialsController {
  constructor(private readonly credentials: AliyunCredentialsService) {}
  @Post(':id/credentials')
  @Header('Cache-Control', 'no-store')
  read(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.credentials.credentials(user, id);
  }
  @Post(':id/credentials/reset')
  @Header('Cache-Control', 'no-store')
  reset(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.credentials.credentials(user, id, true);
  }
}
