"""Guard AnyIO's TLS identity boundary (CVE-2026-63374).

Real TLS over memory streams: no external DNS, network or credentials.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import ssl
import tomllib

import anyio
from anyio.streams.stapled import StapledObjectStream
from anyio.streams.tls import TLSStream
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from packaging.requirements import Requirement
from packaging.version import Version
import pytest


@pytest.mark.parametrize(
    'hostname,certificate_name,accepted',
    [
        ('faß.de', 'fass.de', False),
        ('faß.de', 'xn--fa-hia.de', True),
        ('example.test', 'example.test', True),
        ('example.test', 'other.test', False),
    ],
)
def test_tls_checks_idna2008_identity(tmp_path, hostname, certificate_name, accepted):
    """Reject the IDNA-2003 lookalike without breaking valid IDN/ASCII TLS."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, certificate_name)])
    now = datetime.now(timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(certificate_name)]), critical=False)
        .sign(key, hashes.SHA256())
    )
    cert_pem = certificate.public_bytes(serialization.Encoding.PEM)
    cert_path, key_path = tmp_path / 'cert.pem', tmp_path / 'key.pem'
    cert_path.write_bytes(cert_pem)
    key_path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ))
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(cert_path, key_path)
    client_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    client_context.load_verify_locations(cadata=cert_pem.decode('ascii'))
    assert client_context.check_hostname
    assert client_context.verify_mode == ssl.CERT_REQUIRED

    async def exchange():
        server_send, server_receive = anyio.create_memory_object_stream(4)
        client_send, client_receive = anyio.create_memory_object_stream(4)
        client_stream = StapledObjectStream(client_send, server_receive)
        server_stream = StapledObjectStream(server_send, client_receive)

        async def serve():
            try:
                stream = await TLSStream.wrap(
                    server_stream, server_side=True, ssl_context=server_context,
                )
                request = await stream.receive()
                await stream.send(request[::-1])
            except (ssl.SSLError, anyio.BrokenResourceError, anyio.EndOfStream):
                # The peer intentionally rejects wrong certificates in negative cases.
                pass

        result = None
        with anyio.fail_after(5):
            async with anyio.create_task_group() as tasks:
                tasks.start_soon(serve)
                try:
                    stream = await TLSStream.wrap(
                        client_stream, hostname=hostname, ssl_context=client_context,
                    )
                    await stream.send(b'hello')
                    assert await stream.receive() == b'olleh'
                    result = True
                except ssl.SSLCertVerificationError:
                    result = False
                finally:
                    tasks.cancel_scope.cancel()
        return result

    assert anyio.run(exchange) is accepted


def test_dependency_selection_excludes_vulnerable_anyio():
    """Both normal package installation and the frozen lock must exclude the CVE."""
    root = Path(__file__).resolve().parents[1]
    project = tomllib.loads((root / 'pyproject.toml').read_text(encoding='utf-8'))
    requirements = [Requirement(s) for s in project['project']['dependencies']]
    anyio_requirements = [r for r in requirements if r.name.lower() == 'anyio']
    assert len(anyio_requirements) == 1, 'AnyIO needs an explicit security pin'
    requirement, = anyio_requirements
    assert not requirement.marker, 'The TLS protection is required on every platform'
    assert Version('4.14.1') not in requirement.specifier
    assert Version('4.14.2') in requirement.specifier
    assert Version('5.0.0') not in requirement.specifier
    lock = tomllib.loads((root / 'uv.lock').read_text(encoding='utf-8'))
    packages = [p for p in lock['package'] if p['name'] == 'anyio']
    assert packages, 'AnyIO missing from the lock'
    for package in packages:
        assert Version(package['version']) >= Version('4.14.2')
        assert Version(package['version']) in requirement.specifier
