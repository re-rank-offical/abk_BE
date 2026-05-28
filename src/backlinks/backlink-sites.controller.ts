import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { BacklinkSitesService } from './backlink-sites.service';
import { CreateAuthoritySiteDto } from './dto/create-authority-site.dto';
import { UpdateAuthoritySiteDto } from './dto/update-authority-site.dto';
import { PublishToSitesDto } from './dto/publish-to-sites.dto';

interface AuthUser {
  userId: string;
  email: string;
}

@ApiTags('Backlink Sites')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('backlink-sites')
export class BacklinkSitesController {
  constructor(private readonly service: BacklinkSitesService) {}

  @Get()
  @ApiOperation({ summary: '백링크 사이트 목록 조회' })
  findAll(@CurrentUser() user: AuthUser) {
    return this.service.findAll(user.userId);
  }

  @Post()
  @ApiOperation({ summary: '백링크 사이트 등록' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAuthoritySiteDto) {
    return this.service.create(user.userId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '백링크 사이트 수정' })
  update(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateAuthoritySiteDto,
  ) {
    return this.service.update(id, user.userId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '백링크 사이트 삭제' })
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.service.remove(id, user.userId);
  }

  @Post('publish')
  @HttpCode(202)
  @ApiOperation({ summary: '선택된 사이트에 글 등록 (백그라운드)' })
  publish(@CurrentUser() user: AuthUser, @Body() dto: PublishToSitesDto) {
    return this.service.startPublish(
      user.userId,
      dto.siteIds,
      dto.title,
      dto.body,
    );
  }

  @Get('posts')
  @ApiOperation({ summary: '글 등록 이력 조회' })
  findPosts(@CurrentUser() user: AuthUser) {
    return this.service.findPosts(user.userId);
  }
}
