package main

import "testing"

func TestValidateBaseURLAllowsExactHost(t *testing.T) {
	if err := validateBaseURL("https://jyw.example.com/v1", []string{"jyw.example.com"}); err != nil {
		t.Fatalf("expected exact host to pass: %v", err)
	}
}

func TestValidateBaseURLAllowsSubdomainSuffix(t *testing.T) {
	if err := validateBaseURL("https://gateway.jyw.example.com/v1", []string{".jyw.example.com"}); err != nil {
		t.Fatalf("expected suffix host to pass: %v", err)
	}
}

func TestValidateBaseURLRejectsLookalikeHost(t *testing.T) {
	if err := validateBaseURL("https://eviljyw.example.com/v1", []string{".jyw.example.com"}); err == nil {
		t.Fatal("expected lookalike host to fail")
	}
}

func TestValidateBaseURLRejectsHTTP(t *testing.T) {
	if err := validateBaseURL("http://gateway.jyw.example.com/v1", []string{".jyw.example.com"}); err == nil {
		t.Fatal("expected http baseUrl to fail")
	}
}

func TestModelsURLRespectsExistingV1Path(t *testing.T) {
	got := modelsURL("https://gateway.jyw.example.com/v1")
	want := "https://gateway.jyw.example.com/v1/models"
	if got != want {
		t.Fatalf("modelsURL() = %q, want %q", got, want)
	}
}

func TestModelsURLAppendsV1WhenMissing(t *testing.T) {
	got := modelsURL("https://gateway.jyw.example.com/api")
	want := "https://gateway.jyw.example.com/api/v1/models"
	if got != want {
		t.Fatalf("modelsURL() = %q, want %q", got, want)
	}
}
