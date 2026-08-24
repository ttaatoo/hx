# frozen_string_literal: true

class Hx < Formula
  desc "Unix-like coding agent CLI"
  homepage "https://github.com/ttaatoo/hx"
  version "0.0.6"
  license "Apache-2.0"
  # GitHub Release tarballs (not bottles, not a Vercel blob CDN).
  # Keep version + sha256 :no_check after rebuilding the same tag. Pin
  # sha256 only when bumping version. `brew install --HEAD` builds latest
  # git with Homebrew's Zig.
  on_macos do
    on_arm do
      url "https://github.com/ttaatoo/hx/releases/download/v#{version}/hx-macos-arm64.tar.gz"
      sha256 :no_check
    end
    on_intel do
      url "https://github.com/ttaatoo/hx/releases/download/v#{version}/hx-macos-x86_64.tar.gz"
      sha256 :no_check
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/ttaatoo/hx/releases/download/v#{version}/hx-linux-aarch64.tar.gz"
      sha256 :no_check
    end
    on_intel do
      url "https://github.com/ttaatoo/hx/releases/download/v#{version}/hx-linux-x86_64.tar.gz"
      sha256 :no_check
    end
  end

  head "https://github.com/ttaatoo/hx.git", branch: "main"

  # Homebrew-core `zig` is 0.16.0 (also aliased as zig@0.16).
  depends_on "zig" => :build if build.head?

  def install
    if build.head?
      system "zig", "build", "-Doptimize=ReleaseSafe"
      bin.install "zig-out/bin/hx"
    else
      bin.install "hx"
    end
  end

  def caveats
    <<~EOS
      This is ttaatoo/hx, a Unix-like coding agent based on vercel-labs/fx
      (SuperGrok, Anthropic, and Codex; no Vercel AI Gateway). It is not
      official Vercel fx, not Homebrew-core's `fx` JSON viewer, and not
      the Helix editor.

      Install the stable formula from GitHub Release binaries:

        brew tap ttaatoo/hx https://github.com/ttaatoo/hx
        brew install ttaatoo/hx/hx

      To build the latest git with Homebrew's Zig:

        brew install --HEAD ttaatoo/hx/hx

      Config lives in ~/.hx. If that directory is missing, leftover ~/.fx
      is copied in.
    EOS
  end

  test do
    assert_match(/\d+\.\d+\.\d+/, shell_output("#{bin}/hx --version"))
  end
end
