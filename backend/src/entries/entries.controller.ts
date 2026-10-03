import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from "@nestjs/common";
import { AuthenticatedRequest } from "../auth/auth.guard";
import { EntryQueryDto, MetricQueryDto, SaveEntryDto } from "./entries.dto";
import { EntriesService } from "./entries.service";

@Controller("families/:familyId")
export class EntriesController {
  constructor(private readonly entries: EntriesService) {}

  @Get("entries") @Header("Cache-Control", "no-store")
  list(@Req() request: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) familyId: string, @Query() query: EntryQueryDto) {
    return this.entries.list(request.auth.user.id, familyId, query);
  }

  @Get("metrics") @Header("Cache-Control", "no-store")
  metrics(@Req() request: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) familyId: string, @Query() query: MetricQueryDto) {
    return this.entries.metrics(request.auth.user.id, familyId, query);
  }

  @Get("entries/:entryId") @Header("Cache-Control", "no-store")
  get(@Req() request: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) familyId: string,
    @Param("entryId", new ParseUUIDPipe({ version: "4" })) entryId: string) {
    return this.entries.get(request.auth.user.id, familyId, entryId);
  }

  @Post("entries") @Header("Cache-Control", "no-store")
  create(@Req() request: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) familyId: string, @Body() body: SaveEntryDto) {
    return this.entries.save(request.auth.user.id, familyId, body);
  }

  @Put("entries/:entryId") @Header("Cache-Control", "no-store")
  update(@Req() request: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) familyId: string,
    @Param("entryId", new ParseUUIDPipe({ version: "4" })) entryId: string, @Body() body: SaveEntryDto) {
    return this.entries.save(request.auth.user.id, familyId, body, entryId);
  }

  @Delete("entries/:entryId") @HttpCode(204) @Header("Cache-Control", "no-store")
  remove(@Req() request: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) familyId: string,
    @Param("entryId", new ParseUUIDPipe({ version: "4" })) entryId: string) {
    return this.entries.remove(request.auth.user.id, familyId, entryId);
  }
}
