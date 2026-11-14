# AWS Emulator (https://github.com/aws/aws-emulator), pinned and verified, to
# rehearse deploy/aws/terraform locally before an apply on AWS
# (deploy/aws/emulator/run.sh). AWS publishes no image; its guide builds one
# from the Linux package. This one pins the package version and checks AWS's
# signature on it, where the guide's Dockerfile takes `latest` unverified.
#
# The version is newer than the two weeks docs/RELEASING.md asks of what the
# product depends on: the emulator's LTS channel opened on 2026-11-11 and
# 1.0.365 was signed on 2026-11-14, so no package is two weeks old yet. This
# is a local test tool, not part of anything shipped, and the newest version
# matches AWS most closely.
FROM public.ecr.aws/amazonlinux/amazonlinux:2023 AS verify
ARG EMULATOR_VERSION=1.0.365
ARG ARCH=x86_64
# The key AWS signs the packages with, by fingerprint (the emulator's
# "Getting started on Linux" guide).
ARG KEY_FINGERPRINT=98BCF336A3BE53B734E967C52E5BF49BD940F624
WORKDIR /pkg
# gpg comes from the image's gnupg2-minimal (installing gnupg2 conflicts with
# it), which has no gpg-agent: without --no-autostart an import exits 2.
RUN curl -fsSLo aws-emulator.rpm "https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/aws-emulator-${EMULATOR_VERSION}-1-${ARCH}.rpm" \
 && curl -fsSLo aws-emulator.rpm.sig "https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/aws-emulator-${EMULATOR_VERSION}-1-${ARCH}.rpm.sig" \
 && curl -fsSLo key.asc https://downloads.aws.com/keys/gpg/current.asc \
 && gpg --batch --no-autostart --import key.asc \
 && gpg --batch --with-colons --fingerprint | grep -q "^fpr:::::::::${KEY_FINGERPRINT}:" \
 && gpg --batch --status-fd 1 --verify aws-emulator.rpm.sig aws-emulator.rpm | grep -q "VALIDSIG ${KEY_FINGERPRINT}"

FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal
COPY --from=verify /pkg/aws-emulator.rpm /tmp/aws-emulator.rpm
RUN rpm -i /tmp/aws-emulator.rpm && rm /tmp/aws-emulator.rpm \
 && mkdir -p /home/emulator && chown 1000 /home/emulator
USER 1000
ENV HOME=/home/emulator
# Telemetry off: these runs are nobody's business but ours.
ENV EMULATOR_TELEMETRY=off
EXPOSE 9297
ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0"]
