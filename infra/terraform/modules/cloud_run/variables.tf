variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "service_name" {
  type        = string
  description = "Cloud Run service name"
}

variable "image" {
  type        = string
  description = "Container image URI"
}

variable "region" {
  type        = string
  description = "Cloud Run region"
  default     = "asia-northeast1"
}

variable "min_instances" {
  type        = number
  description = "Minimum number of instances"
  default     = 1
}

variable "max_instances" {
  type        = number
  description = "Maximum number of instances"
  default     = 3
}

variable "timeout_seconds" {
  type        = number
  description = "Request timeout in seconds"
  default     = 3600
}

variable "cpu" {
  type        = string
  description = "CPU allocation"
  default     = "1"
}

variable "memory" {
  type        = string
  description = "Memory allocation"
  default     = "1Gi"
}

variable "env" {
  type        = map(string)
  description = "Environment variables for the container"
  default     = {}
}

variable "service_account" {
  type        = string
  description = "Service account email to run the Cloud Run service"
  default     = null
}

variable "ingress" {
  type        = string
  description = "Ingress setting"
  default     = "all"
}
