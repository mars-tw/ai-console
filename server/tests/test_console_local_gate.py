# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import console_local_gate as gate  # noqa: E402


class ConsoleGateTest(unittest.TestCase):
    GPU0 = "GPU-4d1a2b3c-5e6f-7a8b-9c0d-1e2f3a4b5c6d"
    GPU1 = "GPU-9f8e7d6c-5b4a-3928-1706-a5b4c3d2e1f0"

    @staticmethod
    def manifest():
        return {
            "name": "llama.cpp-win-x86_64-avx2", "version": "2.24.0", "platform": "win",
            "engine": "llama.cpp", "cpu": {"architecture": "x86_64", "instruction_set_extensions": ["AVX2"]},
            "extension_type": "engine", "domains": ["llm"], "supported_model_formats": ["gguf"],
            "minimum_lmstudio_version": "0.4.0+15",
            "engine_protocol_server": {"runtime_kind": "llama-server",
                                       "executable_relative_path": "llama-server.exe"},
        }

    @staticmethod
    def display():
        return [["en", {"langKey": "en", "displayName": "CPU llama.cpp (Windows)",
                        "description": "CPU-only llama.cpp engine", "releaseNotes": []}]]

    def write_meta(self, manifest=None, display=None):
        (self.backend / "backend-manifest.json").write_text(
            json.dumps(self.manifest() if manifest is None else manifest), encoding="utf-8")
        (self.backend / "display-data.json").write_text(
            json.dumps(self.display() if display is None else display), encoding="utf-8")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ac_portable_gate_")
        self.root = Path(self.temp.name)
        self.lms = self.root / "lms.exe"
        self.lms.write_text("fixture", encoding="utf-8")
        self.backend = self.root / ".lmstudio" / "extensions" / "backends" / "llama.cpp-win-x86_64-avx2-2.24.0"
        self.backend.mkdir(parents=True)
        self.write_meta()

    def tearDown(self):
        self.temp.cleanup()

    def args(self, phase="pre", **kwargs):
        data = {"runtime": gate.RUNTIME_ID, "lms_bin": str(self.lms), "phase": phase,
                "owner_nonce": "a" * 10, "identifier": None, "model_key": None}
        data.update(kwargs)
        return SimpleNamespace(**data)

    @staticmethod
    def table(selected=gate.RUNTIME_ID):
        rows = ["LLM ENGINE                                        SELECTED    MODEL FORMAT"]
        for runtime in ("llama.cpp-win-x86_64-avx2@2.33.0", gate.RUNTIME_ID,
                        "llama.cpp-win-x86_64-nvidia-cuda-avx2@2.24.0"):
            marker = "✓" if runtime == selected else ""
            rows.append(f"{runtime:<58}{marker:<13}GGUF")
        return "\n".join(rows)

    def runner(self, *, loaded="[]", selected=gate.RUNTIME_ID, adapter=None):
        adapter = [{"Name": "Intel", "PNPDeviceID": "PCI\\VEN_8086", "AdapterCompatibility": "Intel"}] if adapter is None else adapter
        def run(argv, **kwargs):
            if argv[-2:] == ["ps", "--json"]:
                return subprocess.CompletedProcess(argv, 0, loaded, "")
            if argv[-2:] == ["runtime", "ls"]:
                return subprocess.CompletedProcess(argv, 0, self.table(selected), "")
            if "powershell.exe" in argv[0].casefold():
                return subprocess.CompletedProcess(argv, 0, json.dumps(adapter), "")
            raise AssertionError(argv)
        return run

    def test_pre_known_intel_with_empty_models_allows_cpu_only(self):
        with mock.patch.object(gate.Path, "home", return_value=self.root):
            out = gate.evaluate(self.args(), self.runner(), self.root)
        self.assertTrue(out["ok"])
        self.assertEqual(out["adapterClass"], "non_nvidia")
        self.assertFalse(out["hardwareVerified"])

    def test_pre_loaded_or_unknown_state_blocks(self):
        with mock.patch.object(gate.Path, "home", return_value=self.root):
            loaded = gate.evaluate(self.args(), self.runner(loaded='[{"modelKey":"m","identifier":"i"}]'), self.root)
            malformed = gate.evaluate(self.args(), self.runner(loaded=""), self.root)
        self.assertEqual(loaded["code"], "MODEL_STATE_NOT_EMPTY")
        self.assertEqual(malformed["code"], "MODEL_STATE_UNKNOWN")

    def test_post_requires_exact_owned_row_and_selected_runtime(self):
        model = "qwen/qwen3.5-4b"
        identifier = gate._owned_identifier(model, "a" * 10)
        args = self.args("post", identifier=identifier, model_key=model)
        payload = json.dumps([{"modelKey": model, "identifier": identifier}])
        with mock.patch.object(gate.Path, "home", return_value=self.root):
            good = gate.evaluate(args, self.runner(loaded=payload), self.root)
            cuda = gate.evaluate(args, self.runner(loaded=payload, selected="llama.cpp-win-x86_64-nvidia-cuda-avx2@2.24.0"), self.root)
            foreign = gate.evaluate(self.args("post", identifier="copy", model_key=model), self.runner(loaded=payload), self.root)
        self.assertTrue(good["ok"])
        self.assertEqual(cuda["code"], "CPU_RUNTIME_NOT_SELECTED")
        self.assertEqual(foreign["code"], "MODEL_OWNERSHIP_UNVERIFIED")

    def test_runtime_parser_rejects_middle_column_spoofs_and_header_only(self):
        with self.assertRaises(ValueError):
            gate._runtime_table(self.lms, lambda *a, **k: subprocess.CompletedProcess([], 0, "LLM ENGINE SELECTED MODEL FORMAT", ""))
        spoof = "LLM ENGINE                                        SELECTED    MODEL FORMAT\n" + f"{gate.RUNTIME_ID}-x                     ✓            GGUF\n"
        def spoof_runner(argv, **kwargs):
            if argv[-2:] == ["ps", "--json"]:
                model = "qwen/qwen3.5-4b"
                identifier = gate._owned_identifier(model, "a" * 10)
                return subprocess.CompletedProcess(argv, 0, json.dumps([{"modelKey": model, "identifier": identifier}]), "")
            if argv[-2:] == ["runtime", "ls"]:
                return subprocess.CompletedProcess(argv, 0, spoof, "")
            if "powershell.exe" in argv[0].casefold():
                return subprocess.CompletedProcess(argv, 0, json.dumps([]), "")
            raise AssertionError(argv)
        model = "qwen/qwen3.5-4b"
        with mock.patch.object(gate.Path, "home", return_value=self.root):
            out = gate.evaluate(self.args("post", identifier=gate._owned_identifier(model, "a" * 10), model_key=model), spoof_runner, self.root)
        self.assertEqual(out["code"], "CPU_RUNTIME_NOT_SELECTED")

    def test_unknown_or_mixed_adapter_blocks_and_nvidia_wins(self):
        with mock.patch.object(gate.Path, "home", return_value=self.root):
            unknown = gate.evaluate(self.args(), self.runner(adapter=[{"Name": "Basic", "PNPDeviceID": "x"}]), self.root)
            nvidia = gate.evaluate(self.args(), self.runner(adapter=[
                {"Name": "Intel", "PNPDeviceID": "PCI\\VEN_8086"},
                {"Name": "NVIDIA", "PNPDeviceID": "PCI\\VEN_10DE"},
            ]), self.root)
        self.assertEqual(unknown["code"], "ADAPTER_STATE_UNKNOWN")
        self.assertEqual(nvidia["code"], "GPU_TELEMETRY_UNAVAILABLE")

    def test_runtime_metadata_accepts_vendor_shape_and_rejects_mutations(self):
        meta = gate.runtime_metadata(self.root)
        self.assertEqual((meta["id"], meta["installed"], meta["verified"]), (gate.RUNTIME_ID, True, True))
        entry = self.display()[0][1]
        manifests = {
            "exe_top_level": lambda m: m.__setitem__(
                "executable_relative_path", m["engine_protocol_server"].pop("executable_relative_path")),
            "exe_missing": lambda m: m["engine_protocol_server"].pop("executable_relative_path"),
            "exe_traversal": lambda m: m["engine_protocol_server"].__setitem__(
                "executable_relative_path", "..\\..\\llama-server.exe"),
            "wrong_version": lambda m: m.__setitem__("version", "2.33.0"),
            "domains_string": lambda m: m.__setitem__("domains", "llm"),
            "cpu_features_string": lambda m: m["cpu"].__setitem__("instruction_set_extensions", "AVX2 AVX512"),
            "name_non_scalar": lambda m: m.__setitem__("name", ["llama.cpp-win-x86_64-avx2"]),
            "protocol_non_dict": lambda m: m.__setitem__("engine_protocol_server", "llama-server"),
        }
        for label, mutate in manifests.items():
            with self.subTest(label):
                manifest = self.manifest()
                mutate(manifest)
                self.write_meta(manifest=manifest)
                with self.assertRaises(ValueError):
                    gate.runtime_metadata(self.root)
        displays = {
            "dict_shape": {"en": entry},
            "duplicate_en": [["en", entry], ["en", entry]],
            "pair_not_list": [{"en": entry}],
            "missing_langkey": [["en", {k: v for k, v in entry.items() if k != "langKey"}]],
            "notes_non_list": [["en", dict(entry, releaseNotes="none")]],
            "display_name_non_scalar": [["en", dict(entry, displayName=["CPU llama.cpp (Windows)"])]],
            "no_english": [["zh-TW", dict(entry, langKey="zh-TW")]],
        }
        for label, display in displays.items():
            with self.subTest(label):
                self.write_meta(display=display)
                with self.assertRaises(ValueError):
                    gate.runtime_metadata(self.root)

    def adapter_runner(self, payload, rc=0):
        text = payload if isinstance(payload, str) else json.dumps(payload)
        def run(argv, **kwargs):
            self.assertIn("powershell.exe", argv[0].casefold())
            return subprocess.CompletedProcess(argv, rc, text, "")
        return run

    def test_adapter_class_from_injected_runner_without_cim(self):
        intel = {"Name": "Intel(R) UHD Graphics", "PNPDeviceID": "PCI\\VEN_8086&DEV_9A60", "AdapterCompatibility": "Intel Corporation"}
        amd = {"Name": "AMD Radeon", "PNPDeviceID": "PCI\\VEN_1002&DEV_1636", "AdapterCompatibility": "Advanced Micro Devices, Inc."}
        nvidia = {"Name": "NVIDIA GeForce RTX 4060", "PNPDeviceID": "PCI\\VEN_10DE&DEV_2882", "AdapterCompatibility": "NVIDIA"}
        cases = {
            "intel": ([intel], "non_nvidia"),
            "amd": ([amd], "non_nvidia"),
            "intel_amd": ([intel, amd], "non_nvidia"),
            "headless_empty_array": ([], "headless"),
            "nvidia_precedence": ([intel, amd, nvidia], "nvidia"),
            "nvidia_vendor_name": ([{"Name": "GPU", "PNPDeviceID": "ROOT\\BASICDISPLAY", "AdapterCompatibility": "NVIDIA Corporation"}], "nvidia"),
            "remote_intel_name_only": ([{"Name": "Intel Remote Display", "PNPDeviceID": "ROOT\\DISPLAY", "AdapterCompatibility": "Intel"}], "unknown"),
            "non_pci_spoof": ([{"Name": "Intel", "PNPDeviceID": "USB\\VEN_8086&DEV_0001", "AdapterCompatibility": "Intel"}], "unknown"),
            "dict_field": ([{"Name": {"x": 1}, "PNPDeviceID": "PCI\\VEN_8086"}], "unknown"),
            "list_field": ([{"Name": ["Intel"], "PNPDeviceID": "PCI\\VEN_8086"}], "unknown"),
            "int_field": ([{"Name": "Intel", "PNPDeviceID": 8086}], "unknown"),
            "object_not_array": (intel, "unknown"),
            "blank_output": ("", "unknown"),
            "oversized": ([intel] * 65, "unknown"),
        }
        for label, (payload, expected) in cases.items():
            with self.subTest(label):
                self.assertEqual(gate._adapter_class(self.adapter_runner(payload)), expected)
        self.assertEqual(gate._adapter_class(self.adapter_runner([intel], rc=1)), "unknown")

    def gpu_table(self):
        return f"0, {self.GPU0}\n1, {self.GPU1}\n"

    @staticmethod
    def nv_runner(gpus, apps, *, gpu_rc=0, app_rc=0):
        def run(argv, **kwargs):
            if "--query-compute-apps=gpu_uuid,pid,process_name,used_memory" in argv:
                return subprocess.CompletedProcess(argv, app_rc, apps, "")
            return subprocess.CompletedProcess(argv, gpu_rc, gpus, "")
        return run

    @mock.patch.object(gate.shutil, "which", return_value=r"C:\Windows\System32\nvidia-smi.exe")
    def test_nvidia_clean_telemetry_shapes(self, _which):
        good = {
            "empty_apps": (self.gpu_table(), "\n"),
            "benign_numeric": (self.gpu_table(), f"{self.GPU1}, 900, python.exe, 128\n"),
            "benign_na": (self.gpu_table(), f"{self.GPU1}, 900, python.exe, N/A\n"),
            "benign_bracket_na": (self.gpu_table(), f"{self.GPU1}, 900, python.exe, [N/A]\n"),
            "gpu0_non_lm": (self.gpu_table(), f"{self.GPU0}, 900, python.exe, [N/A]\n"),
        }
        for label, (gpus, apps) in good.items():
            with self.subTest(label):
                self.assertEqual(gate._nvidia_clean(self.nv_runner(gpus, apps), has_loaded=True),
                                 (True, "GPU0_VERIFIED_IDLE"))
        bad = {
            "invalid_uuid": ("0, GPU-1234\n", "\n"),
            "duplicate_uuid": (f"0, {self.GPU0}\n1, {self.GPU0}\n", "\n"),
            "duplicate_index": (f"0, {self.GPU0}\n0, {self.GPU1}\n", "\n"),
            "padded_index": (f"00, {self.GPU0}\n", "\n"),
            "missing_gpu0": (f"1, {self.GPU1}\n", "\n"),
            "wide_gpu_row": (f"0, {self.GPU0}, extra\n", "\n"),
            "unknown_app_uuid": (self.gpu_table(), "GPU-11112222-3333-4444-5555-666677778888, 900, python.exe, 128\n"),
            "zero_pid": (self.gpu_table(), f"{self.GPU1}, 0, python.exe, 128\n"),
            "text_pid": (self.gpu_table(), f"{self.GPU1}, pid, python.exe, 128\n"),
            "bad_memory": (self.gpu_table(), f"{self.GPU1}, 900, python.exe, 128 MiB\n"),
            "blank_process": (self.gpu_table(), f"{self.GPU1}, 900, , 128\n"),
            "oversized": ("0, " + "x" * gate._MAX_OUTPUT + "\n", "\n"),
        }
        for label, (gpus, apps) in bad.items():
            with self.subTest(label):
                self.assertEqual(gate._nvidia_clean(self.nv_runner(gpus, apps), has_loaded=False),
                                 (False, "GPU_TELEMETRY_UNAVAILABLE"))
        for label, kwargs in (("gpu_rc", {"gpu_rc": 1}), ("app_rc", {"app_rc": 1})):
            with self.subTest(label):
                self.assertEqual(gate._nvidia_clean(self.nv_runner(self.gpu_table(), "\n", **kwargs), has_loaded=False),
                                 (False, "GPU_TELEMETRY_UNAVAILABLE"))
        with mock.patch.object(gate.shutil, "which", return_value=None):
            self.assertEqual(gate._nvidia_clean(self.nv_runner(self.gpu_table(), "\n")),
                             (False, "GPU_TELEMETRY_UNAVAILABLE"))

    @mock.patch.object(gate.shutil, "which", return_value=r"C:\Windows\System32\nvidia-smi.exe")
    def test_nvidia_clean_gpu0_lm_process_blocks_for_memory_sentinels(self, _which):
        processes = ("C:/Program Files/LM Studio/LM Studio.exe",
                     "C:\\Users\\u\\.lmstudio\\extensions\\backends\\llama-server.exe",
                     "lmstudio.exe", "LM-Studio.exe", "llama.cpp")
        for process in processes:
            for memory in ("4096", "N/A", "[N/A]", "n/a", "[n/a]"):
                with self.subTest(process=process, memory=memory):
                    apps = f"{self.GPU0}, 4242, {process}, {memory}\n"
                    self.assertEqual(gate._nvidia_clean(self.nv_runner(self.gpu_table(), apps), has_loaded=True),
                                     (False, "GPU0_LM_PROCESS_ACTIVE"))
                    self.assertEqual(gate._nvidia_clean(self.nv_runner(self.gpu_table(), apps)),
                                     (False, "GPU0_LM_PROCESS_ACTIVE"))
                    self.assertEqual(gate._nvidia_clean(self.nv_runner(self.gpu_table(), apps), has_loaded=False),
                                     (True, "GPU0_VERIFIED_IDLE"))
        malformed = f"{self.GPU0}, 4242, LM Studio.exe, 12 MiB\n"
        self.assertEqual(gate._nvidia_clean(self.nv_runner(self.gpu_table(), malformed), has_loaded=False),
                         (False, "GPU_TELEMETRY_UNAVAILABLE"))

    @unittest.skipUnless(os.name == "nt", "Windows PowerShell serializer only")
    def test_windows_powershell_serializer_emits_arrays_for_0_1_many_rows(self):
        powershell = (Path(os.environ.get("SystemRoot", r"C:\Windows"))
                      / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe")
        self.assertTrue(powershell.is_file(), powershell)
        self.assertIn("Get-CimInstance -ClassName Win32_VideoController", gate._ADAPTER_PS_COMMAND)
        for bypass in ("\\Get-CimInstance", "&", "Invoke-Expression", "Microsoft.Management.Infrastructure"):
            self.assertNotIn(bypass, gate._ADAPTER_PS_COMMAND)
        names = ["Intel(R) UHD Graphics", "顯示卡二號 NVIDIA", "AMD Radeon"]
        def build(count, extra=""):
            rows = ";".join("[pscustomobject]@{Name='" + names[i] + "';PNPDeviceID='PCI\\VEN_8086&DEV_000"
                            + str(i) + "';AdapterCompatibility='Synthetic';ConfigManagerErrorCode=0}"
                            for i in range(count))
            stub = "function Get-CimInstance { param([string]$ClassName) @(" + rows + ") }\n"
            return stub + extra + gate._ADAPTER_PS_COMMAND + "\n"
        def run_ps(body):
            script = self.root / "test.ps1"
            script.write_text(body, encoding="utf-8-sig")
            return subprocess.run([str(powershell), "-NoProfile", "-NonInteractive",
                                   "-File", str(script)],
                                  capture_output=True, text=True, encoding="utf-8", errors="replace",
                                  timeout=60, creationflags=subprocess.CREATE_NO_WINDOW)
        for count in (0, 1, 3):
            with self.subTest(rows=count):
                out = run_ps(build(count))
                self.assertEqual(out.returncode, 0, out.stderr)
                rows = gate._parse_json_text(out.stdout)
                self.assertIsInstance(rows, list)
                self.assertEqual(len(rows), count)
                self.assertEqual([row["Name"] for row in rows], names[:count])
        blank = run_ps(build(2, "function ConvertTo-Json { param($InputObject, $Depth, [switch]$Compress) '' }\n"))
        self.assertEqual(blank.returncode, 0, blank.stderr)
        self.assertEqual(blank.stdout.strip(), "")
        self.assertEqual(gate._adapter_class(self.adapter_runner(blank.stdout)), "unknown")


if __name__ == "__main__":
    unittest.main()
