# owlette.app failover load balancer.
#
# Topology: one health monitor hitting /api/health on each origin, two single-
# origin pools (railway primary, vercel standby), and a load balancer on
# owlette.app that cascades — Railway first, Vercel only when Railway's health
# check fails. steering_policy = "off" means "use default_pool_ids in order",
# which is exactly failover.
#
# Each origin sends its own Host header, and Cloudflare uses an origin's header
# override for that origin's health checks too (it beats the monitor's). Railway
# serves owlette.app. Vercel is reached as vercel-origin.owlette.app, a DNS-only
# name it holds a certificate for: Vercel renews certificates over HTTP-01, and
# for owlette.app itself those challenges would land on Railway. The web app
# builds outbound links from NEXT_PUBLIC_BASE_URL (lib/publicOrigin.server.ts),
# never the Host header, so the alias doesn't leak to users.
#
# Provider auth + version pin live in versions.tf. The monitor + pools are
# account-scoped; the load balancer is zone-scoped.

resource "cloudflare_load_balancer_monitor" "health" {
  account_id       = var.account_id
  type             = "https"
  method           = "GET"
  path             = "/api/health"
  port             = 443
  expected_codes   = "200"
  interval         = 60
  timeout          = 5
  retries          = 2
  follow_redirects = false
  allow_insecure   = false
  description      = "owlette /api/health readiness probe"

  header {
    header = "Host"
    values = [var.app_host]
  }
}

resource "cloudflare_load_balancer_pool" "railway" {
  account_id         = var.account_id
  name               = "owlette-railway-primary"
  monitor            = cloudflare_load_balancer_monitor.health.id
  enabled            = true
  minimum_origins    = 1
  notification_email = var.notification_email

  origins {
    name    = "railway"
    address = var.railway_origin
    enabled = true

    header {
      header = "Host"
      values = [var.app_host]
    }
  }
}

resource "cloudflare_load_balancer_pool" "vercel" {
  account_id         = var.account_id
  name               = "owlette-vercel-standby"
  monitor            = cloudflare_load_balancer_monitor.health.id
  enabled            = true
  minimum_origins    = 1
  notification_email = var.notification_email

  origins {
    name    = "vercel"
    address = var.vercel_origin
    enabled = true

    # The name Vercel holds a certificate for, not owlette.app — see the header.
    header {
      header = "Host"
      values = [var.vercel_origin]
    }
  }
}

resource "cloudflare_load_balancer" "owlette" {
  zone_id         = var.zone_id
  name            = coalesce(var.lb_host, var.app_host)
  proxied         = true
  steering_policy = "off"
  description     = "owlette.app failover: railway primary, vercel standby"

  default_pool_ids = [
    cloudflare_load_balancer_pool.railway.id,
    cloudflare_load_balancer_pool.vercel.id,
  ]

  fallback_pool_id = cloudflare_load_balancer_pool.vercel.id

  # Zero-downtime failover: when Railway's endpoint is unreachable mid-request,
  # retry against the Vercel pool immediately instead of waiting for the next
  # health-check cycle (~60s). Single-endpoint pools, so cross-pool is the only
  # failover path — this is what makes the Railway→Vercel handoff instant.
  adaptive_routing {
    failover_across_pools = true
  }
}
