import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put, Req } from "@nestjs/common";
import { AuthenticatedRequest } from "../auth/auth.guard";
import { MediaService } from "./media.service";
import { UploadDto, StorageQuotaDto } from "./media.dto";

@Controller()
export class MediaController {
  constructor(private readonly media: MediaService) {}
  @Get("families/:familyId/storage") @Header("Cache-Control", "no-store")
  quota(@Req() req: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) family: string) { return this.media.quota(req.auth.user.id, family); }

  @Post("families/:familyId/assets") @Header("Cache-Control", "no-store")
  start(@Req() req: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) family: string, @Body() body: UploadDto) { return this.media.start(req.auth.user.id, family, body); }

  @Get("families/:familyId/assets/:assetId") @Header("Cache-Control", "no-store")
  get(@Req() req: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) family: string, @Param("assetId", new ParseUUIDPipe({ version: "4" })) id: string) { return this.media.get(req.auth.user.id, family, id); }

  @Post("families/:familyId/assets/:assetId/authorize") @Header("Cache-Control", "no-store")
  authorize(@Req() req: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) family: string, @Param("assetId", new ParseUUIDPipe({ version: "4" })) id: string) { return this.media.authorize(req.auth.user.id, family, id); }

  @Post("families/:familyId/assets/:assetId/complete") @Header("Cache-Control", "no-store")
  complete(@Req() req: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) family: string, @Param("assetId", new ParseUUIDPipe({ version: "4" })) id: string) { return this.media.complete(req.auth.user.id, family, id); }

  @Delete("families/:familyId/assets/:assetId") @Header("Cache-Control", "no-store") @HttpCode(204)
  cancel(@Req() req: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) family: string, @Param("assetId", new ParseUUIDPipe({ version: "4" })) id: string) { return this.media.cancel(req.auth.user.id, family, id); }

  @Get("admin/families/:familyId/storage") @Header("Cache-Control", "no-store")
  adminQuota(@Req() req: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) family: string) {
    return this.media.adminQuota(req.auth.user.id, family);
  }

  @Put("admin/families/:familyId/storage") @Header("Cache-Control", "no-store")
  setQuota(@Req() req: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) family: string, @Body() body: StorageQuotaDto) { return this.media.setQuota(req.auth.user.id, family, body.quotaBytes, body.reason); }

}
