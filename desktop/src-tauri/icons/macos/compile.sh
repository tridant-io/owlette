#!/bin/zsh
# recompiles Assets.car from AppIcon.icon, the icon composer source whose light and dark specializations give
# macos 26 the day eye on a light tile and the night eye on a dark one. needs xcode 26's actool (the macos-26 ci
# runner has it; the command line tools alone do not). commit the new Assets.car with the source change.
set -eu
here=${0:A:h}
out=$(mktemp -d)
xcrun actool "$here/AppIcon.icon" --compile "$out" --platform macosx --minimum-deployment-target 15.0 \
  --app-icon AppIcon --output-partial-info-plist "$out/partial.plist" --errors --warnings
cp "$out/Assets.car" "$here/Assets.car"
echo "wrote $here/Assets.car"
