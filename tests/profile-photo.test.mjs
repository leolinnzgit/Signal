import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../app/profile-photo.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const profilePhoto = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

test("centers landscape and portrait profile-photo crops", () => {
  assert.deepEqual(profilePhoto.calculateSquareCrop(1200, 800), {
    sourceX: 200,
    sourceY: 0,
    sourceSize: 800,
  });
  assert.deepEqual(profilePhoto.calculateSquareCrop(800, 1200), {
    sourceX: 0,
    sourceY: 200,
    sourceSize: 800,
  });
});

test("accepts image files within the source-size limit", () => {
  assert.doesNotThrow(() => profilePhoto.validateProfilePhotoSelection({
    type: "image/heic",
    size: 4_000_000,
  }));
});

test("rejects non-images and oversized source photos", () => {
  assert.throws(
    () => profilePhoto.validateProfilePhotoSelection({ type: "text/html", size: 100 }),
    /image file/,
  );
  assert.throws(
    () => profilePhoto.validateProfilePhotoSelection({
      type: "image/jpeg",
      size: profilePhoto.PROFILE_PHOTO_MAX_SOURCE_BYTES + 1,
    }),
    /smaller than 20 MB/,
  );
});
