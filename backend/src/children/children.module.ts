import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { FamiliesModule } from "../families/families.module";
import { ChildrenController } from "./children.controller";
import { ChildrenService } from "./children.service";

@Module({ imports: [DatabaseModule, FamiliesModule], controllers: [ChildrenController], providers: [ChildrenService] })
export class ChildrenModule {}
