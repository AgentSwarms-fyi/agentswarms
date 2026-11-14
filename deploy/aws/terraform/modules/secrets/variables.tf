variable "name" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "recovery_window_days" {
  description = "Days a deleted secret can still be restored. 0 deletes it at once (a throwaway test)."
  type        = number
  default     = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
