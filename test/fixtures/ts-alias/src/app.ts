import type {
  Shape,
  Size,
} from "./types";
import Default, {
  helper,
} from "./util";
import { alias } from "@/lib/helper";
import exact from "#helper";
import a from "./a.js"; import b from "./b.js";
import "./side-effect";
export * from "./re";
export type { Only } from "./type-re";
const c = require("./cjs");
const d = import("./dyn");
import { external } from "some-package";
// import { commented } from "./commented";
const s = "import { fake } from './fake'";
export { Default, helper, alias, exact, a, b, c, d, external, s };
