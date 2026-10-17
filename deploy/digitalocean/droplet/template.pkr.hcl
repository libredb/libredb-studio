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
  description = "LibreDB Studio release tag — image pin + snapshot name (e.g. 0.14.1). Must exist on ghcr.io/libredb/libredb-studio."
}

# Region and size are variables, not literals, because the pair can stop being
# buildable without anything here changing: DigitalOcean answers 422 "Size is
# not available in this region" when a region has no capacity for that size,
# and the snapshot is identical whichever region builds it. The 0.18.3 build
# failed twice on nyc3/s-1vcpu-1gb while both were listed as available. With
# these as variables the workflow can retry elsewhere instead of standing down.
variable "region" {
  type        = string
  default     = "nyc3"
  description = "Build region. Any region offering the size works; the snapshot is region-independent."
}

variable "size" {
  type        = string
  default     = "s-1vcpu-1gb"
  description = "Build droplet size. Only used while building; it does not constrain what users deploy."
}

source "digitalocean" "ubuntu" {
  image         = "ubuntu-24-04-x64"
  region        = var.region
  size          = var.size
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

  provisioner "file" {
    source      = "files/usr/"
    destination = "/usr/"
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
