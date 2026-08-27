import { Module } from '@nestjs/common';
import { SkillsModule } from '../skills/skills.module';
import { ExperiencesService } from './experiences.service';
import { HelpController } from './help.controller';
import { HelpService } from './help.service';
import { HelpersService } from './helpers.service';

@Module({
  imports: [SkillsModule],
  controllers: [HelpController],
  providers: [HelpersService, HelpService, ExperiencesService],
})
export class HelpModule {}
