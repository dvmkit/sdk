# Commit and tag signing

Every commit in this repository, and every release tag, is signed with one SSH key. This file records that key so a signature can be verified by anyone, on any machine, without access to the maintainer's workstation.

## The signing identity

| | |
| --- | --- |
| Name | `aioli3` |
| Email | `265668992+aioli3@users.noreply.github.com` |
| Key type | `ssh-ed25519` |
| Fingerprint | `SHA256:IdxmUMNRiILXrECIIgytXvRcmMAhLW2/fYaFKvdVuCA` |

The public key is:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIOAABfWAkQaX/F7qoDtDVT1APZho1qYllrCaXQOCWXR 265668992+aioli3@users.noreply.github.com
```

[`.github/release-signers`](../.github/release-signers) holds the same key in `ssh_config`'s allowed-signers format, scoped to the `git` namespace. That file is the allow-list the release workflow verifies release tags against, so a tag signed by any other key fails the pipeline before anything is built.

## Verifying a signature yourself

Git needs an allowed-signers file to say whose signature it will accept. The repository ships one, so no local key material is needed:

```sh
git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=.github/release-signers log --show-signature -1
git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=.github/release-signers verify-commit <commit>
git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=.github/release-signers tag -v v1.2.3
```

A good signature prints `Good "git" signature for 265668992+aioli3@users.noreply.github.com with ED25519 key SHA256:IdxmUMNRiILXrECIIgytXvRcmMAhLW2/fYaFKvdVuCA`. Compare that fingerprint against the table above; it is the only thing worth reading closely, because the email in the output comes from the allow-list rather than from the signature.

To confirm the shipped allow-list matches the fingerprint without trusting this document:

```sh
ssh-keygen -lf <(awk '{ print $3, $4, $1 }' .github/release-signers)
```

## Rotation

Replacing the key means replacing the allow-list, and old tags stop verifying against a file that no longer contains the key that signed them. Add the new key to `.github/release-signers` and keep the old one until every tag it signed is out of support; remove it in its own commit, signed by the new key, so the history records the handover.
