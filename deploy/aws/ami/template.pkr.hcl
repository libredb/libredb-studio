packer {
  required_plugins {
    amazon = {
      version = ">= 1.3.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "version" {
  type        = string
  description = "LibreDB Studio release tag (e.g. 0.14.0) — AMI name and version title."
}

variable "image_ref" {
  type        = string
  description = "Digest-pinned app image, e.g. ghcr.io/libredb/libredb-studio@sha256:... Resolved by the workflow."

  # A tag would let the image under a buyer's instance change after the scan that
  # approved it, and an empty value would substitute cleanly into the unit file
  # and ship a broken ExecStart that only fails on the buyer's first boot.
  validation {
    condition     = can(regex("^[a-z0-9._/-]+@sha256:[0-9a-f]{64}$", var.image_ref))
    error_message = "The image_ref value must be a digest-pinned image reference, because a tag can move after the AMI has been scanned."
  }
}

# No default, on purpose: AWS requires a real support contact and the mailbox is
# a human decision, so a build cannot start before that decision exists. The
# validation is not typo-catching decoration either — this value is fed to `sed`
# as replacement text, where an unescaped `&` means "the whole match", and `&` is
# legal in an email local part.
variable "support_email" {
  type        = string
  description = "Support contact printed in the first-boot banner. Must be a monitored mailbox."

  validation {
    condition     = can(regex("^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$", var.support_email))
    error_message = "The support_email value must be a plain address, because sed metacharacters (& \\ |) are not supported."
  }
}

# The base image comes from Canonical's public SSM parameter rather than a name
# filter: the product is a path segment (`/server/`), so no wildcard can reach a
# neighbouring product (Ubuntu Pro carries a billingProducts code and its AMIs
# cannot be re-listed), and `current` tracks the newest published serial, so
# every build starts from a freshly patched base. The volume type is `ebs-gp3`
# in the SSM path and `ssd-gp3` in an AMI name — easy to mix up.
data "amazon-parameterstore" "ubuntu_2404" {
  name   = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
  region = "us-east-1"
}

source "amazon-ebs" "ubuntu" {
  region        = "us-east-1" # AWS Marketplace requires the source AMI here
  instance_type = "t3.small"
  # Canonical's default user. AWS recommends ec2-user; `ubuntu` is what every
  # Ubuntu-based listing uses and what the listing's OS user name field states.
  ssh_username = "ubuntu"

  source_ami = data.amazon-parameterstore.ubuntu_2404.value

  # Seconds, not just the date: AMI names are unique per account and Region, so
  # a same-day rebuild of the same version would fail CreateImage with
  # InvalidAMIName.Duplicate at the END of a ~15-minute build — and rebuilding
  # the same version on the same day is the normal case (the scan loop does it).
  # `force_deregister` would also clear the collision, and is deliberately left
  # off: it deregisters the AMI carrying that name, which may be the one AWS is
  # reading for a version request that is still under review.
  ami_name = "libredb-studio-${var.version}-${formatdate("YYYYMMDD-hhmmss", timestamp())}"
  # ASCII only, like every buyer-visible string. The tail is the listing
  # description's first sentence verbatim, because the AMI product checklist
  # asks the two to match.
  ami_description = "LibreDB Studio ${var.version} - Open-source SQL IDE for cloud-native teams."

  # Instances launched from this AMI require IMDSv2.
  imds_support = "v2.0"

  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = 20
    volume_type           = "gp3"
    delete_on_termination = true
    encrypted             = false # Marketplace forbids encrypted snapshots
  }

  temporary_key_pair_type = "ed25519"
  # HashiCorp calls this "a mostly cosmetic option" that only works on guests
  # with sed installed, so it is the second lock on the same door — the control
  # is 90-cleanup.sh removing the keys and then asserting they are gone.
  ssh_clear_authorized_keys = true

  tags = {
    Name       = "libredb-studio-${var.version}"
    AppVersion = var.version
    AppImage   = var.image_ref
    BuiltBy    = "packer"
  }
  snapshot_tags = {
    Name = "libredb-studio-${var.version}"
  }
}

build {
  sources = ["source.amazon-ebs.ubuntu"]

  # Do not fight cloud-init for the apt lock
  provisioner "shell" {
    inline = ["cloud-init status --wait || true"]
  }

  provisioner "shell" {
    environment_vars = ["DEBIAN_FRONTEND=noninteractive", "NEEDRESTART_MODE=a"]
    inline = [
      "sudo -E apt-get update -y",
      "sudo -E apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade",
    ]
  }

  # `env {{ .Vars }}`, not a bare `sudo -E bash`: Packer's declared
  # environment_vars ride in that one expansion, which the default
  # execute_command carries and a custom one has to carry itself. Without it the
  # variables are declared and never delivered, and 01-install.sh dies on
  # `IMAGE_REF: unbound variable` a quarter of an hour into the build. Passing
  # them as arguments to `env` also keeps them out of sudo's environment policy.
  provisioner "shell" {
    script           = "scripts/01-install.sh"
    execute_command  = "sudo -E env {{ .Vars }} bash '{{ .Path }}'"
    environment_vars = ["IMAGE_REF=${var.image_ref}", "DEBIAN_FRONTEND=noninteractive", "NEEDRESTART_MODE=a"]
  }

  # Packer's file provisioner cannot write to root-owned paths as the ssh user,
  # and a directory upload needs its destination to exist — stage under /tmp,
  # then install with the right owner and mode in 02-configure.sh.
  provisioner "shell" {
    inline = ["mkdir -p /tmp/libredb-files"]
  }

  provisioner "file" {
    source      = "files/"
    destination = "/tmp/libredb-files/"
  }

  provisioner "shell" {
    script          = "scripts/02-configure.sh"
    execute_command = "sudo -E env {{ .Vars }} bash '{{ .Path }}'"
    environment_vars = [
      "IMAGE_REF=${var.image_ref}",
      "VERSION=${var.version}",
      "SUPPORT_EMAIL=${var.support_email}",
    ]
  }

  # LAST. Nothing may run after this, and the machine must not reboot.
  provisioner "shell" {
    script          = "scripts/90-cleanup.sh"
    execute_command = "sudo -E bash '{{ .Path }}'"
  }

  post-processor "manifest" {
    output = "packer-manifest.json"
  }
}
