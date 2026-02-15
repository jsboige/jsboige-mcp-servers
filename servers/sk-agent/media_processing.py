#!/usr/bin/env python3
"""
Media Processing Module for sk-agent.

Handles image and video processing:
- Image cropping and resizing
- Video frame extraction
- Image format conversion
"""

from __future__ import annotations

import io
import logging
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log = logging.getLogger("sk-agent.media")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAX_IMAGE_BYTES = 4 * 1024 * 1024  # 4 MB
MAX_IMAGE_PIXELS = 774_144  # Qwen3-VL mini default (roughly 880x880)


# ---------------------------------------------------------------------------
# Image Processing
# ---------------------------------------------------------------------------

def _crop_image(data: bytes, media_type: str, region: dict) -> tuple[bytes, str]:
    """Crop image to specified region.

    Args:
        data: Raw image bytes
        media_type: MIME type of the image
        region: Dict with x, y, width, height (pixels or percentages)

    Returns:
        Tuple of (cropped_image_bytes, media_type)
    """
    img = Image.open(io.BytesIO(data))
    img_w, img_h = img.size

    # Parse region - support both pixels and percentages
    def parse_value(val: float | str, total: int) -> int:
        if isinstance(val, str) and val.endswith("%"):
            return int(float(val[:-1]) / 100 * total)
        return int(val)

    x = parse_value(region.get("x", 0), img_w)
    y = parse_value(region.get("y", 0), img_h)
    w = parse_value(region.get("width", region.get("w", img_w)), img_w)
    h = parse_value(region.get("height", region.get("h", img_h)), img_h)

    # Clamp to image bounds
    x = max(0, min(x, img_w - 1))
    y = max(0, min(y, img_h - 1))
    w = min(w, img_w - x)
    h = min(h, img_h - y)

    # Crop
    cropped = img.crop((x, y, x + w, y + h))

    buf = io.BytesIO()
    fmt = "JPEG" if media_type in ("image/jpeg", "image/jpg") else "PNG"
    cropped.save(buf, format=fmt)
    out_type = f"image/{fmt.lower()}"

    log.info("Cropped image %dx%d -> %dx%d", img_w, img_h, w, h)
    return buf.getvalue(), out_type


def _resize_image_if_needed(
    data: bytes,
    media_type: str,
    max_bytes: int = MAX_IMAGE_BYTES,
    max_pixels: int = MAX_IMAGE_PIXELS,
) -> tuple[bytes, str]:
    """Resize image if it exceeds size limits.

    Args:
        data: Raw image bytes
        media_type: MIME type of the image
        max_bytes: Maximum file size in bytes
        max_pixels: Maximum pixel count (width * height)

    Returns:
        Tuple of (possibly_resized_image_bytes, media_type)
    """
    img = Image.open(io.BytesIO(data))
    img_w, img_h = img.size
    current_pixels = img_w * img_h

    # Check if resize is needed
    needs_resize = len(data) > max_bytes or current_pixels > max_pixels

    if not needs_resize:
        return data, media_type

    # Calculate scale factor
    if current_pixels > max_pixels:
        scale = (max_pixels / current_pixels) ** 0.5
    else:
        scale = 1.0

    # Resize if needed
    if scale < 1.0:
        new_w = int(img_w * scale)
        new_h = int(img_h * scale)
        img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
        log.info("Resized image from %dx%d to %dx%d", img_w, img_h, new_w, new_h)

    # Save with appropriate format
    buf = io.BytesIO()
    if media_type in ("image/jpeg", "image/jpg"):
        # Use JPEG with quality reduction if still too large
        quality = 85
        while quality >= 50:
            buf.seek(0)
            buf.truncate()
            img.save(buf, format="JPEG", quality=quality)
            if len(buf.getvalue()) <= max_bytes:
                break
            quality -= 5
        out_type = "image/jpeg"
    else:
        img.save(buf, format="PNG")
        out_type = "image/png"

    result = buf.getvalue()
    log.info("Image size: %d -> %d bytes", len(data), len(result))
    return result, out_type


def _image_to_base64_url(data: bytes, media_type: str) -> str:
    """Convert image bytes to base64 data URL.

    Args:
        data: Raw image bytes
        media_type: MIME type of the image

    Returns:
        Base64 data URL string
    """
    import base64
    encoded = base64.b64encode(data).decode("utf-8")
    return f"data:{media_type};base64,{encoded}"


# ---------------------------------------------------------------------------
# Video Processing
# ---------------------------------------------------------------------------

@dataclass
class VideoInfo:
    """Video metadata."""
    duration: float  # seconds
    width: int
    height: int
    fps: float
    codec: str
    has_audio: bool


def _get_video_info(video_path: str) -> VideoInfo | None:
    """Get video metadata using ffprobe.

    Args:
        video_path: Path to the video file

    Returns:
        VideoInfo object or None if extraction fails
    """
    try:
        cmd = [
            "ffprobe", "-v", "quiet",
            "-print_format", "json",
            "-show_format", "-show_streams",
            video_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

        if result.returncode != 0:
            return None

        import json
        info = json.loads(result.stdout)

        # Find video stream
        video_stream = None
        audio_stream = None
        for stream in info.get("streams", []):
            if stream.get("codec_type") == "video" and video_stream is None:
                video_stream = stream
            elif stream.get("codec_type") == "audio" and audio_stream is None:
                audio_stream = stream

        if not video_stream:
            return None

        duration = float(info.get("format", {}).get("duration", 0))
        width = int(video_stream.get("width", 0))
        height = int(video_stream.get("height", 0))

        # Parse frame rate (can be "30/1" or "29.97")
        fps_str = video_stream.get("r_frame_rate", "30/1")
        if "/" in fps_str:
            num, den = fps_str.split("/")
            fps = float(num) / float(den) if float(den) > 0 else 30.0
        else:
            fps = float(fps_str)

        return VideoInfo(
            duration=duration,
            width=width,
            height=height,
            fps=fps,
            codec=video_stream.get("codec_name", "unknown"),
            has_audio=audio_stream is not None,
        )

    except (subprocess.TimeoutExpired, json.JSONDecodeError, ValueError, KeyError) as e:
        log.warning("Failed to get video info: %s", e)
        return None


def _extract_video_frames(
    video_path: str,
    num_frames: int = 8,
    start_time: float | None = None,
    end_time: float | None = None,
) -> list[tuple[bytes, str]]:
    """Extract frames from a video file using ffmpeg.

    Args:
        video_path: Path to the video file
        num_frames: Number of frames to extract (evenly distributed)
        start_time: Optional start time in seconds
        end_time: Optional end time in seconds

    Returns:
        List of (frame_bytes, media_type) tuples
    """
    # Get video info for duration
    video_info = _get_video_info(video_path)
    if video_info:
        duration = video_info.duration
    else:
        log.warning("Could not get video duration, using default method")
        duration = None

    # Determine time range
    if duration:
        start = max(0, start_time or 0)
        end = min(duration, end_time or duration)
        effective_duration = end - start
    else:
        start = start_time or 0
        effective_duration = None

    frames = []

    if effective_duration and effective_duration > 0:
        # Extract evenly distributed frames within the range
        timestamps = [start + effective_duration * (i + 0.5) / num_frames for i in range(num_frames)]
    else:
        # Fallback: extract at fixed intervals
        timestamps = [start + i * 2.0 for i in range(num_frames)]

    with tempfile.TemporaryDirectory() as tmpdir:
        for i, ts in enumerate(timestamps):
            output_path = os.path.join(tmpdir, f"frame_{i:03d}.jpg")
            try:
                cmd = [
                    "ffmpeg", "-y", "-ss", str(ts), "-i", video_path,
                    "-frames:v", "1", "-q:v", "2", output_path
                ]
                subprocess.run(cmd, capture_output=True, timeout=30, check=True)

                if os.path.exists(output_path):
                    with open(output_path, "rb") as f:
                        frame_data = f.read()
                    frames.append((frame_data, "image/jpeg"))
                    log.info("Extracted frame %d at %.2fs from video", i, ts)
            except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError) as e:
                log.warning("Failed to extract frame %d: %s", i, e)
                continue

    log.info("Extracted %d frames from video: %s", len(frames), video_path)
    return frames


def _extract_keyframes(video_path: str, num_frames: int = 8) -> list[tuple[bytes, str]]:
    """Extract keyframes (I-frames) from a video using ffmpeg.

    Keyframes are typically at scene changes and provide better visual
    representation than evenly distributed frames.

    Args:
        video_path: Path to the video file
        num_frames: Maximum number of keyframes to extract

    Returns:
        List of (frame_bytes, media_type) tuples
    """
    frames = []

    with tempfile.TemporaryDirectory() as tmpdir:
        output_pattern = os.path.join(tmpdir, "keyframe_%03d.jpg")

        try:
            # Extract keyframes using ffmpeg
            cmd = [
                "ffmpeg", "-i", video_path,
                "-vf", f"select='eq(pict_type,I)',scale=720:-1",
                "-vsync", "vfr",
                "-q:v", "2",
                "-frames:v", str(num_frames),
                output_pattern
            ]
            subprocess.run(cmd, capture_output=True, timeout=60, check=True)

            # Collect extracted frames
            for frame_file in sorted(Path(tmpdir).glob("keyframe_*.jpg")):
                with open(frame_file, "rb") as f:
                    frame_data = f.read()
                frames.append((frame_data, "image/jpeg"))
                log.info("Extracted keyframe: %s", frame_file.name)

        except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError) as e:
            log.warning("Keyframe extraction failed, falling back to uniform: %s", e)
            return _extract_video_frames(video_path, num_frames=num_frames)

    log.info("Extracted %d keyframes from video: %s", len(frames), video_path)
    return frames
