"use client";

import { Clock3 } from "lucide-react";
import { toEmbedUrl } from "./video-url";

export function LessonVideo({ src, title, durationMinutes }: { src: string; title: string; durationMinutes: number }) {
  const video = toEmbedUrl(src);

  return (
    <div className="lesson-player lesson-player-video">
      {video?.kind === "file" ? (
        <video aria-label={title} controls preload="metadata" src={video.url} />
      ) : (
        <iframe
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          aria-label={title}
          src={video?.url ?? src}
          title={title}
        />
      )}
      <div className="lesson-player-meta">
        <Clock3 size={13} /> <span>{durationMinutes} minutes</span>
      </div>
    </div>
  );
}
