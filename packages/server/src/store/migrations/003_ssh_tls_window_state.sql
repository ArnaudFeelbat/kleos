-- 0.4: SSH tunnel and private CA per favorite, trusted SSH host keys, restored window.

-- JSON SshConfig or NULL for a direct connection.
ALTER TABLE connections ADD COLUMN ssh TEXT;
-- PEM file of a private CA (sslrootcert) or NULL for the system CAs.
ALTER TABLE connections ADD COLUMN ssl_root_cert_path TEXT;
-- Whether the Keychain holds the SSH key passphrase (account "<id>:ssh"); never the passphrase itself.
ALTER TABLE connections ADD COLUMN has_ssh_passphrase INTEGER NOT NULL DEFAULT 0;

-- Trust on first use: the SSH host key fingerprint accepted for each host and port.
CREATE TABLE ssh_known_hosts (
  host        TEXT NOT NULL,
  port        INTEGER NOT NULL,
  -- OpenSSH style, e.g. "SHA256:uQ3j…" (base64 of the SHA-256 of the key, no padding)
  fingerprint TEXT NOT NULL,
  added_at    TEXT NOT NULL,
  PRIMARY KEY (host, port)
);

-- One row: the servers and query tabs to restore on relaunch (JSON WindowState).
CREATE TABLE window_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  state      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
