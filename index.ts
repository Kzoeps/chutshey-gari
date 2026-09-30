import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { registerRemindersExtension } from "./extension.ts";

export default function remindersExtension(pi: ExtensionAPI): void {
  registerRemindersExtension(pi, {
    Object: Type.Object,
    String: Type.String,
    Integer: Type.Integer,
    Optional: Type.Optional,
    StringEnum,
  });
}
