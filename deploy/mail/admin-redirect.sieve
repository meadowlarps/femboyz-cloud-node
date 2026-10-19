require ["copy"];
# femboyz: admin@ redirect. Managed by hand, see DEPLOYMENT.md section 13.
# Install with REDIRECT_TO replaced by the admin's personal address.

# Keep DMARC/TLS aggregate reports here instead of forwarding them.
if address :is ["to", "cc"] ["dmarc@femboyz.cloud", "postmaster@femboyz.cloud"] {
    stop;
}

# Never forward what the spam filter flagged. X-Spam-Status is only added at
# mailbox ingest, after Sieve runs; X-Spam-Score is set during SMTP DATA.
if header :matches "X-Spam-Score" "spam*" {
    stop;
}

redirect :copy "REDIRECT_TO";
