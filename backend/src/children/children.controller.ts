import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Put, Req } from "@nestjs/common";
import { AuthenticatedRequest } from "../auth/auth.guard";
import { SaveChildDto } from "./children.dto";
import { ChildrenService } from "./children.service";

@Controller("families/:familyId/children")
export class ChildrenController {
  constructor(private readonly children: ChildrenService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  list(@Req() request: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) familyId: string) {
    return this.children.list(request.auth.user.id, familyId);
  }

  @Get(":childId")
  @Header("Cache-Control", "no-store")
  get(@Req() request: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) familyId: string,
    @Param("childId", new ParseUUIDPipe({ version: "4" })) childId: string) {
    return this.children.get(request.auth.user.id, familyId, childId);
  }

  @Post()
  @Header("Cache-Control", "no-store")
  create(@Req() request: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) familyId: string,
    @Body() body: SaveChildDto) {
    return this.children.save(request.auth.user.id, familyId, body);
  }

  @Put(":childId")
  @Header("Cache-Control", "no-store")
  update(@Req() request: AuthenticatedRequest, @Param("familyId", new ParseUUIDPipe({ version: "4" })) familyId: string,
    @Param("childId", new ParseUUIDPipe({ version: "4" })) childId: string, @Body() body: SaveChildDto) {
    return this.children.save(request.auth.user.id, familyId, body, childId);
  }
}
