variable "project_prefix" {
  default = "befaas"
}

variable "build_timestamp" {
  default = ""
}

variable "experiment" {
}

variable "run_id" {
  description = "Unique identifier for this experiment run (e.g., faas#auth-type#256MB#workload#2025-12-07T16-18-36-564Z)"
  default     = ""
}
