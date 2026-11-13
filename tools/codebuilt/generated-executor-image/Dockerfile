# Generated-code executor image (offline runtime): CPU launcher plus GPU launcher. The GPU launcher is NOT approved until its review.
# Build context = this directory plus the verified Blender tarball (blender-5.2.2-linux-x64.tar.xz, not in git).
# Same pinned base, Blender and headless runtime as ../blender-proof-image. Build-time network is used only by apt.
# Runtime must be --network none; the executor passes the fixed launcher as the command.

# Stage 1: assemble the one static MIT launcher. Only the binary ships.
FROM debian@sha256:c67e92c8099ba22853ab4cfda7cfb494d253d6012ca82dee98ba8976772af018 AS asm
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends binutils && rm -rf /var/lib/apt/lists/*
COPY launcher.S /src/launcher.S
RUN cd /src && as --64 -o l.o launcher.S && ld -static -nostdlib -z noexecstack -e _start -o blender-generated l.o \
 && as --64 --defsym GPU=1 -o lg.o launcher.S && ld -static -nostdlib -z noexecstack -e _start -o blender-generated-gpu lg.o

# Stage 2: the executor image.
FROM debian@sha256:c67e92c8099ba22853ab4cfda7cfb494d253d6012ca82dee98ba8976772af018
ARG DEBIAN_FRONTEND=noninteractive
# Minimal headless X/GL runtime for the Blender tarball. No ffmpeg, no CUDA/NVIDIA packages (the NVIDIA container runtime injects the
# driver libraries only when a GPU is requested at launch), no shell tooling added.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 libsm6 libice6 \
      libgl1 libegl1 libxext6 libdbus-1-3 \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* \
 && mkdir -p /job /opt/forge /kit && chmod 1777 /job
# Verify the tarball against the official sum before it is extracted into the image.
# SHA-256 84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168
RUN --mount=type=bind,source=blender-5.2.2-linux-x64.tar.xz,target=/mnt/blender.tar.xz \
    echo "84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168  /mnt/blender.tar.xz" | sha256sum -c -
ADD blender-5.2.2-linux-x64.tar.xz /opt/
COPY --from=asm --chmod=0555 /src/blender-generated /opt/forge/blender-generated
COPY --from=asm --chmod=0555 /src/blender-generated-gpu /opt/forge/blender-generated-gpu
COPY --chmod=0444 entry.py entry_gpu.py /opt/forge/
WORKDIR /job
# No shell ENTRYPOINT. The executor passes the fixed launcher as the command; this default is the same.
CMD ["/opt/forge/blender-generated"]
