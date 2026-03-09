import { test, expect, describe } from "bun:test";
import { Schema } from "effect";
import { extractFieldMetadata, getIndexedFields } from "../src/annotations.ts";

describe("annotations", () => {
  test("extractFieldMetadata returns metadata for all fields", () => {
    const PersonV1 = Schema.TaggedStruct("Person.v1", {
      firstName: Schema.String,
      lastName: Schema.String,
      email: Schema.String.annotate({ index: true }),
    });

    const metadata = extractFieldMetadata(PersonV1);

    expect(metadata).toEqual([
      { name: "firstName", index: false },
      { name: "lastName", index: false },
      { name: "email", index: true },
    ]);
  });

  test("extractFieldMetadata skips _tag field", () => {
    const MySchema = Schema.TaggedStruct("Test.v1", {
      value: Schema.String,
    });

    const metadata = extractFieldMetadata(MySchema);
    expect(metadata.find((f) => f.name === "_tag")).toBeUndefined();
  });

  test("getIndexedFields returns only indexed field names", () => {
    const PersonV1 = Schema.TaggedStruct("Person.v1", {
      firstName: Schema.String,
      lastName: Schema.String,
      email: Schema.String.annotate({ index: true }),
      ssn: Schema.String.annotate({ index: true }),
    });

    const indexed = getIndexedFields(PersonV1);
    expect(indexed).toEqual(["email", "ssn"]);
  });

  test("getIndexedFields returns empty array when no indexes", () => {
    const NoIndexSchema = Schema.TaggedStruct("NoIndex.v1", {
      name: Schema.String,
    });

    const indexed = getIndexedFields(NoIndexSchema);
    expect(indexed).toEqual([]);
  });
});
