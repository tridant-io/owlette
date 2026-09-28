variable "account_id" {
  type        = string
  description = "Cloudflare account ID that owns the load-balancing monitor + pools."
}

variable "zone_id" {
  type        = string
  description = "Cloudflare zone ID for the owlette.app zone."
}

variable "app_host" {
  type        = string
  description = "Public hostname the LB serves; also sent to origins as the Host header so Railway/Vercel route + TLS correctly."
  default     = "owlette.app"
}

variable "lb_host" {
  type        = string
  description = "Hostname the load balancer is created on. Empty (the default) means app_host. Set it to a throwaway name such as lbtest.owlette.app to rehearse failover against the real origins and Host headers without touching app_host."
  default     = ""
}

variable "railway_origin" {
  type        = string
  description = "Railway origin hostname (PRIMARY pool), e.g. owlette-prod-xxxx.up.railway.app — hostname only, no scheme."
}

variable "vercel_origin" {
  type        = string
  description = "Vercel origin hostname (STANDBY pool): vercel-origin.owlette.app, a DNS-only record pointing at Vercel. Also sent as that pool's Host header — Vercel holds a certificate for this name, not for owlette.app. Hostname only, no scheme."
}

variable "notification_email" {
  type        = string
  description = "Optional email for pool health notifications. Empty disables notifications."
  default     = ""
}
