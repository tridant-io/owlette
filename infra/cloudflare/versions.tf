# Owlette failover load balancer — provider + version pins.
#
# Pinned to the cloudflare provider v4 line: its Load Balancing schema is stable
# and well-documented. The v5 provider (auto-generated from the API schema) is a
# breaking rewrite — migrating is a deliberate future step, not a silent upgrade,
# so the upper bound below intentionally excludes v5.
terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.52"
    }
  }

  # State: local by default. For durable/shared state, move to an R2-backed S3
  # backend (Cloudflare R2 speaks the S3 protocol). Uncomment and fill in once an
  # R2 bucket + scoped access keys exist for terraform state:
  #
  # backend "s3" {
  #   bucket                      = "owlette-tfstate"
  #   key                         = "cloudflare/failover.tfstate"
  #   region                      = "auto"
  #   endpoints                   = { s3 = "https://<account-id>.r2.cloudflarestorage.com" }
  #   skip_credentials_validation = true
  #   skip_region_validation      = true
  #   skip_requesting_account_id  = true
  #   skip_s3_checksum            = true
  #   use_path_style              = true
  # }
}

# Authentication: the provider reads the CLOUDFLARE_API_TOKEN env var automatically.
# Mint a token scoped to: Account › Load Balancing: Monitors and Pools (Edit) +
# Zone › Load Balancers (Edit) + Zone › Transform Rules (Edit) for the owlette.app
# zone. Never put the token in a file.
provider "cloudflare" {}
