# Blender proof image (CPU, offline runtime). Build context = this directory plus the verified
# Blender tarball (blender-5.2.2-linux-x64.tar.xz, not in git). See README.md.
# Build-time network is used only by apt (Debian signed repos). Runtime must be --network none.

# Stage 1: assemble the three static MIT launchers. Nothing from this stage ships except the binaries.
FROM debian@sha256:c67e92c8099ba22853ab4cfda7cfb494d253d6012ca82dee98ba8976772af018 AS asm
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends binutils && rm -rf /var/lib/apt/lists/*
COPY launcher.S /src/launcher.S
RUN cd /src \
 && as --64 --defsym MODE=0 -o l0.o launcher.S && ld -static -nostdlib -z noexecstack -e _start -o blender-proof l0.o \
 && as --64 --defsym MODE=1 -o l1.o launcher.S && ld -static -nostdlib -z noexecstack -e _start -o blender-proof-denied l1.o \
 && as --64 --defsym MODE=2 -o l2.o launcher.S && ld -static -nostdlib -z noexecstack -e _start -o blender-proof-third l2.o

# Stage 2: the proof image.
FROM debian@sha256:c67e92c8099ba22853ab4cfda7cfb494d253d6012ca82dee98ba8976772af018
ARG DEBIAN_FRONTEND=noninteractive
# Minimal headless X/GL runtime for the Blender tarball. No ffmpeg, no GPU stack.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 libsm6 libice6 \
      libgl1 libegl1 libxext6 libdbus-1-3 \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* \
 && mkdir -p /job /opt/forge && chmod 1777 /job
# Verify the tarball against the official sum before it is extracted into the image.
# SHA-256 84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168
RUN --mount=type=bind,source=blender-5.2.2-linux-x64.tar.xz,target=/mnt/blender.tar.xz \
    echo "84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168  /mnt/blender.tar.xz" | sha256sum -c -
ADD blender-5.2.2-linux-x64.tar.xz /opt/
COPY --from=asm --chmod=0555 /src/blender-proof /src/blender-proof-denied /src/blender-proof-third /opt/forge/
COPY --chmod=0444 proof.py /opt/forge/proof.py
WORKDIR /job
# No shell ENTRYPOINT. The executor passes the fixed launcher as the command; this default is the same.
CMD ["/opt/forge/blender-proof"]
