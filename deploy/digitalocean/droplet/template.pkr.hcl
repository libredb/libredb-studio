packer {
  required_plugins {
    digitalocean = {
      version = ">= 1.4.0"
      source  = "github.com/digitalocean/digitalocean"
    }
  }
}

variable "version" {
  type        = string
  description = "LibreDB Studio release tag — image pin + snapshot name (e.g. 0.9.59). Must exist on ghcr.io/libredb/libredb-studio."
}

source "digitalocean" "ubuntu" {
  image         = "ubuntu-24-04-x64"
  region        = "nyc3"
  size          = "s-1vcpu-1gb"
  ssh_username  = "root"
  snapshot_name = "libredb-studio-${var.version}-${formatdate("YYYYMMDD", timestamp())}"
  # api_token is read from the DIGITALOCEAN_TOKEN env var
}

build {
  sources = ["source.digitalocean.ubuntu"]

  # Don't touch apt before the build droplet's own cloud-init finishes (lock contention)
  provisioner "shell" {
    inline = ["cloud-init status --wait || true"]
  }

  provisioner "shell" {
    environment_vars = ["DEBIAN_FRONTEND=noninteractive", "NEEDRESTART_MODE=a"]
    inline = [
      "apt-get update -y",
      "apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade",
    ]
  }

  provisioner "shell" {
    script           = "scripts/01-install.sh"
    environment_vars = ["VERSION=${var.version}", "DEBIAN_FRONTEND=noninteractive", "NEEDRESTART_MODE=a"]
  }

  provisioner "file" {
    source      = "files/etc/"
    destination = "/etc/"
  }

  provisioner "file" {
    source      = "files/var/"
    destination = "/var/"
  }

  provisioner "shell" {
    script           = "scripts/02-configure.sh"
    environment_vars = ["VERSION=${var.version}"]
  }

  # DO's official scripts (fetched from the marketplace-partners repo, not ours).
  # 90-cleanup.sh wipes the cloud-init semaphores — NEVER reboot after it runs.
  provisioner "shell" {
    scripts = [
      "scripts/90-cleanup.sh",
      "scripts/99-img-check.sh",
    ]
  }

  post-processor "manifest" {
    output = "packer-manifest.json"
  }
}
