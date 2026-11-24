import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';

export class GenerateContentDto {
  @ApiProperty({ description: '글 제목' })
  @IsString()
  title: string;

  @ApiPropertyOptional({ description: '주요 키워드 (쉼표 구분)' })
  @IsOptional()
  @IsString()
  keywords?: string;

  @ApiPropertyOptional({ description: '추가 작성 지침' })
  @IsOptional()
  @IsString()
  instruction?: string;
}
