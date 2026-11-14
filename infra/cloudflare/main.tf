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

  # never leave this unset: null probes from every cloudflare data center
  # (~12-23 req/s per origin, each a firestore read, billed per call on
  # vercel). our plan allows one region; ENAM is where vercel runs (iad1).
  check_regions = ["ENAM"]

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
  check_regions      = ["ENAM"] # see the railway pool

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

# Request headers the edge adds before any origin fetch, on both app hosts:
# X-Owlette-Asn is the client's network (its ASN) and X-Owlette-Edge is a
# shared secret the origins compare against EDGE_SHARED_SECRET. Every origin
# answers direct requests around cloudflare, where a client-supplied
# CF-Connecting-IP is believed, so a request without the secret is treated as
# one of unknown network. "set" overwrites a client's own copy of either header.
# The rule matches the public host, so it also covers requests the load
# balancer sends to the vercel standby.
resource "cloudflare_ruleset" "edge_headers" {
  zone_id     = var.zone_id
  name        = "owlette edge headers"
  description = "client asn and the edge secret to the origin"
  kind        = "zone"
  phase       = "http_request_late_transform"

  rules {
    description = "x-owlette-asn and x-owlette-edge on owlette.app and dev.owlette.app"
    expression  = "http.host in {\"owlette.app\" \"dev.owlette.app\"}"
    action      = "rewrite"
    enabled     = true

    action_parameters {
      headers {
        name       = "X-Owlette-Asn"
        operation  = "set"
        expression = "to_string(ip.src.asnum)"
      }

      headers {
        name      = "X-Owlette-Edge"
        operation = "set"
        value     = var.edge_shared_secret
      }
    }
  }
}
