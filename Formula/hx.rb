# frozen_string_literal: true

class Hx < Formula
  desc "Unix-like coding agent CLI"
  homepage "https://github.com/ttaatoo/hx"
  version "0.0.6"
  license "Apache-2.0"
  # GitHub Release tarballs (not bottles, not a Vercel blob CDN).
  # The release workflow opens a formula-update PR with the four checksums
  # after each new release is published. `brew install --HEAD` builds the
  # latest git with Homebrew's Zig.
  head "https://github.com/ttaatoo/hx.git", branch: "main"

  on_macos do
    on_arm do
      url "https://github.com/ttaatoo/hx/releases/download/v#{version}/hx-macos-arm64.tar.gz"
      sha256 "a430f9a8845bcc2239cc802fe5a7728273a2ea4344cb72f57cea82f2222112f9"
    end
    on_intel do
      url "https://github.com/ttaatoo/hx/releases/download/v#{version}/hx-macos-x86_64.tar.gz"
      sha256 "5255620823a438194ab078f735b46270b2d2e2d0d0937ea47a78e689b58e5180"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/ttaatoo/hx/releases/download/v#{version}/hx-linux-aarch64.tar.gz"
      sha256 "d656ab68254d28491f76d8802396c666643822b8d4a328fbf622117a08304ae0"
    end
    on_intel do
      url "https://github.com/ttaatoo/hx/releases/download/v#{version}/hx-linux-x86_64.tar.gz"
      sha256 "5c0b512c8ac1c4af501edbe4954d404982fb91b221ef5dafc30bedcfa873c7ab"
    end
  end

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
      This is ttaatoo/hx, a Unix-like coding agent derived from vercel-labs/fx
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
