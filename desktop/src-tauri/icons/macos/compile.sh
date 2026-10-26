#!/bin/zsh
# recompiles Assets.car from AppIcon.icon, the icon composer source whose light and dark specializations give
# macos 26 the day eye on a light tile and the night eye on a dark one. needs xcode 26's actool (the macos-26 ci
# runner has it; the command line tools alone do not). commit the new Assets.car with the source change.
# compiles the icon in this folder, or in the folder given (desktop/viewer/icons/macos for owlette swoop).
set -eu
dir=${1:-${0:A:h}}
out=$(mktemp -d)
xcrun actool "$dir/AppIcon.icon" --compile "$out" --platform macosx --minimum-deployment-target 15.0 \
  --app-icon AppIcon --output-partial-info-plist "$out/partial.plist" --errors --warnings
cp "$out/Assets.car" "$dir/Assets.car"
echo "wrote $dir/Assets.car"
