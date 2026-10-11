# ReelForge Studio — third-party notices

This file records the runtime dependencies shipped through the lockfile. The exact versions are in `package-lock.json`; this summary is not a replacement for each package's license text.

## Application dependencies

The application uses Fastify, React, React DOM, React Router, TanStack Query, Zod, Vite, TypeScript, Vitest, Playwright, `tsx`, and their transitive dependencies. Their license texts remain available in the installed package directories and in the package metadata used by npm. ReelForge Studio does not relicense those dependencies; users redistributing a copy should retain the notices required by the corresponding licenses.

## Bundled media tools

`ffmpeg-static@5.3.0` supplies the Windows `ffmpeg.exe` used by the renderer. The shipped executable's accompanying `ffmpeg.exe.README` identifies it as FFmpeg 6.1.1 essentials, built by gyan.dev, with a **GPL v3** build. The package metadata declares `GPL-3.0-or-later`, and the package includes `ffmpeg.exe.LICENSE`. This is not an MIT FFmpeg distribution. Keep the executable notice and GPL text with redistributed copies, and review the obligations of the exact binary and any modifications.

`ffprobe-static@3.1.0` supplies the platform-specific `ffprobe.exe` (version 4.0.2) through an MIT-licensed Node wrapper. The wrapper's MIT license does not change the license of the FFmpeg-derived executable it points to. This workspace's Windows binary reports a GPL-enabled, version-3 FFmpeg build; retain the applicable FFmpeg notices when redistributing it and do not describe the executable itself as MIT.

The setup command validates both bundled files and runs each with `-version`. ReelForge Studio does not require a system FFmpeg or FFprobe on `PATH` and does not download a replacement at runtime when the bundled packages are present.
