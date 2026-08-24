import { describe, expect, it } from "vitest";
import { toEmbedUrl } from "./video-url";

describe("toEmbedUrl", () => {
  it("converts YouTube watch URLs to embeds", () => {
    expect(toEmbedUrl("https://www.youtube.com/watch?v=abc123")).toEqual({
      kind: "embed",
      url: "https://www.youtube.com/embed/abc123",
    });
  });

  it("converts short youtu.be URLs to embeds", () => {
    expect(toEmbedUrl("https://youtu.be/abc123")).toEqual({
      kind: "embed",
      url: "https://www.youtube.com/embed/abc123",
    });
  });

  it("converts Vimeo URLs to player embeds", () => {
    expect(toEmbedUrl("https://vimeo.com/987654321")).toEqual({
      kind: "embed",
      url: "https://player.vimeo.com/video/987654321",
    });
  });

  it("passes direct video files through as playable files", () => {
    expect(toEmbedUrl("https://cdn.example.com/lesson-04.mp4")).toEqual({
      kind: "file",
      url: "https://cdn.example.com/lesson-04.mp4",
    });
  });

  it("falls back to a raw embed for other providers", () => {
    expect(toEmbedUrl("https://player.example.com/embed/xyz")).toEqual({
      kind: "embed",
      url: "https://player.example.com/embed/xyz",
    });
  });

  it("rejects values that are not usable URLs", () => {
    expect(toEmbedUrl("not a url")).toBeNull();
    expect(toEmbedUrl("javascript:alert(1)")).toBeNull();
  });
});
