import { describe } from "vitest";
import { lambda } from "./hosts";
import { serverlessSuite } from "./serverless";

describe("aws-lambda function", () => {
  serverlessSuite(lambda);
});
